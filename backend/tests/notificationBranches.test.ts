// Notifications remember the branch they're about, so someone moved off a branch stops seeing that branch's
// older notifications in the list, the unread count and the stream's replay.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Types } from "mongoose";
import { BusinessModel } from "../src/models/Business";
import { MembershipModel } from "../src/models/Membership";
import { NotificationModel } from "../src/models/Notification";
import { UserModel } from "../src/models/User";
import { setEmailProvider } from "../src/services/email";
import { pocketTargetReached, teamRoleChanged } from "../src/services/notificationEvents";
import { signAccessToken } from "../src/services/tokens";
import { encrypt } from "../src/utils/crypto";
import { signStaffToken, startTestEnv, withPin, type TestEnv } from "./helpers";

let t: TestEnv;
let staffToken: string;

beforeAll(async () => {
  t = await startTestEnv();
  setEmailProvider({ send: async () => {} });
  staffToken = await signStaffToken("branches-super@linkpay.test", "super_admin");
});
afterAll(() => t.stop());

let seq = 0;
async function user(name: string) {
  seq++;
  const u = await withPin(await UserModel.create({ name, email: `${name.toLowerCase()}${seq}@branches.ng`, password: "x", emailVerified: true }));
  return { user: u, id: u.id as string, token: await signAccessToken(u.id) };
}

/** Approved business with a head office and a Kano branch. */
async function setup() {
  const owner = await user("Owner");
  const business = await BusinessModel.create({
    owner: owner.user._id,
    name: `Branches Ltd ${seq}`,
    type: "limited_liability_company",
    email: `biz${seq}@branches.ng`,
    address: { street: "1 Marina", city: "Lagos", state: "Lagos" },
    people: [{ fullName: "Ada Obi", roles: ["director"], bvnEncrypted: encrypt("12345678901"), bvnLast4: "8901" }],
    status: "submitted",
  });
  expect((await t.api("POST", `/api/admin/businesses/${business.id}/approve`, { token: staffToken })).status).toBe(200);
  const kanoId = (await t.api("POST", "/api/branches", { token: owner.token, body: { name: "Kano" } })).body._id as string;
  const headOfficeId = (await t.api("GET", "/api/branches", { token: owner.token })).body[0]._id as string;
  return { owner, business, kanoId, headOfficeId };
}

const visibleIds = async (token: string) => ((await t.api("GET", "/api/notifications?take=100", { token })).body.items as any[]).map((n) => n._id as string);
const unread = async (token: string) => (await t.api("GET", "/api/notifications/unread-count", { token })).body.total as number;

/** What reconnecting to the stream replays (Last-Event-ID before everything), and its unread count. */
async function replay(token: string) {
  const ctrl = new AbortController();
  const res = await fetch(`${t.url}/api/notifications/stream`, {
    headers: { Authorization: `Bearer ${token}`, "Last-Event-ID": new Types.ObjectId("000000000000000000000000").toString() },
    signal: ctrl.signal,
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: ready")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  ctrl.abort();
  const ids = [...text.matchAll(/id: (\w+)\nevent: notification/g)].map((m) => m[1]!);
  const ready = JSON.parse(text.match(/event: ready\ndata: (.*)\n/)![1]!);
  return { ids, unread: ready.unread as number };
}

describe("notifications and branch access", () => {
  test("the branch is stored for branch events, and moving off a branch hides that branch's older notifications", async () => {
    const { owner, business, kanoId, headOfficeId } = await setup();
    // Branch events store their branch (here: each branch's account becoming ready).
    const ready = await NotificationModel.find({ recipient: owner.user._id, type: "account.ready" }).sort({ _id: 1 });
    expect(ready.map((n) => String(n.branch))).toEqual([headOfficeId, kanoId]);

    const kanoMember = await user("Finance");
    const membership = await MembershipModel.create({ business: business._id, user: kanoMember.user._id, role: "finance", branches: [kanoId] });

    // About Kano (branch stored), about the business as a whole (no branch), and one from before branches
    // were stored (no branch either).
    await pocketTargetReached(business, { _id: new Types.ObjectId(), name: "Tax", branch: new Types.ObjectId(kanoId), target: { amountKobo: 100_00 } });
    const kano = (await NotificationModel.findOne({ recipient: kanoMember.user._id, type: "savings.target_reached" }))!;
    expect(String(kano.branch)).toBe(kanoId);
    await teamRoleChanged(business, kanoMember.id, "finance");
    const wide = (await NotificationModel.findOne({ recipient: kanoMember.user._id, type: "team.role_changed" }))!;
    expect(wide.branch ?? null).toBeNull();
    const legacy = await NotificationModel.create({
      audience: "user",
      recipient: kanoMember.user._id,
      business: business._id,
      businessName: business.name,
      type: "payment.received",
      title: "Money in",
      body: "From before branches were recorded.",
    });
    const all = [kano.id, wide.id, legacy.id].sort();

    expect((await visibleIds(kanoMember.token)).sort()).toEqual(all);
    expect(await unread(kanoMember.token)).toBe(3);

    // Moved from Kano to the head office.
    const moved = await t.api("PATCH", `/api/team/members/${membership.id}`, { token: owner.token, body: { branches: [headOfficeId] } });
    expect(moved.status).toBe(200);
    const left = [wide.id, legacy.id].sort();
    expect((await visibleIds(kanoMember.token)).sort()).toEqual(left);
    expect(await unread(kanoMember.token)).toBe(2);
    const replayed = await replay(kanoMember.token);
    expect(replayed.ids.sort()).toEqual(left);
    expect(replayed.unread).toBe(2);
    // Asking for the business's notifications doesn't get around it.
    const byBusiness = await t.api("GET", `/api/notifications?business=${business.id}`, { token: kanoMember.token });
    expect(byBusiness.body.items.map((n: any) => n._id).sort()).toEqual(left);

    // Hidden, not deleted: given every branch again, it's back.
    expect((await t.api("PATCH", `/api/team/members/${membership.id}`, { token: owner.token, body: { branches: [] } })).status).toBe(200);
    expect((await visibleIds(kanoMember.token)).sort()).toEqual(all);
    expect((await replay(kanoMember.token)).ids.sort()).toEqual(all);
  });

  test("owners and business-wide roles see every branch's notifications", async () => {
    const { owner, business, kanoId } = await setup();
    const admin = await user("Admin");
    // An admin is business-wide even with branches listed.
    await MembershipModel.create({ business: business._id, user: admin.user._id, role: "admin", branches: [kanoId] });
    await pocketTargetReached(business, { _id: new Types.ObjectId(), name: "Rent", branch: new Types.ObjectId(kanoId), target: { amountKobo: 100_00 } });
    for (const who of [owner, admin]) {
      const target = await NotificationModel.findOne({ recipient: who.user._id, type: "savings.target_reached" });
      expect(target).toBeTruthy();
      expect(await visibleIds(who.token)).toContain(target!.id);
    }
  });
});
