import type { RequestHandler } from "express";
import { isValidObjectId, type Types } from "mongoose";
import { z } from "zod";
import { STAFF_ROLE_DETAILS, STAFF_ROLES } from "../config/staffPermissions";
import { StaffModel, type StaffDocument } from "../models/Staff";
import { StaffInviteModel, type StaffInviteDocument } from "../models/StaffInvite";
import { sendStaffInviteEmail } from "../services/email";
import {
  STAFF_INVITE_RESEND_COOLDOWN_MS,
  STAFF_INVITE_TTL_MS,
  assertKeepsASuperAdmin,
  hashStaffInviteToken,
  newStaffInviteToken,
  parseStaffRole,
  staffInviteLink,
  staffInviteStatus,
  staffRoleLabel,
} from "../services/staff";
import { audit, staffActor } from "../services/audit";
import { staffRoleChanged } from "../services/notificationEvents";
import { revokeStaffSessions, serializeStaff } from "../services/staffAuth";
import { HttpError } from "../utils/HttpError";

type IdParams = { id: string };

/** `{ _id, name }` for each id, looked up in one query. */
async function namesById(ids: (Types.ObjectId | null | undefined)[]) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const staff = unique.length ? await StaffModel.find({ _id: { $in: unique } }).select("name") : [];
  return new Map(staff.map((s) => [s.id as string, { _id: s.id as string, name: s.name }]));
}

async function serializeStaffList(staff: StaffDocument[], viewerId: string) {
  const inviters = await namesById(staff.map((s) => s.invitedBy));
  return staff.map((s) => ({
    ...serializeStaff(s),
    invitedBy: (s.invitedBy && inviters.get(String(s.invitedBy))) ?? null,
    isYou: s.id === viewerId,
  }));
}

async function serializeInvites(invites: StaffInviteDocument[]) {
  const inviters = await namesById(invites.map((i) => i.invitedBy));
  return invites.map((invite) => ({
    _id: invite.id as string,
    email: invite.email,
    role: invite.role,
    roleLabel: staffRoleLabel(invite.role),
    status: staffInviteStatus(invite),
    expiresAt: invite.expiresAt,
    lastSentAt: invite.lastSentAt,
    invitedBy: inviters.get(String(invite.invitedBy)) ?? null,
    createdAt: invite.createdAt,
  }));
}

async function findStaffMember(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const staff = await StaffModel.findById(id);
  if (!staff) throw new HttpError(404, "Staff member not found", "STAFF_NOT_FOUND");
  return staff;
}

/** Staff management never acts on the person making the request. */
async function findOtherStaff(req: { staffId?: string; params: IdParams }) {
  const staff = await findStaffMember(req.params.id);
  if (staff.id === req.staffId) throw new HttpError(400, "You can't change your own staff access", "CANNOT_MODIFY_SELF");
  return staff;
}

async function findPendingInvite(id: string) {
  if (!isValidObjectId(id)) throw new HttpError(400, "Invalid id");
  const invite = await StaffInviteModel.findById(id);
  if (!invite) throw new HttpError(404, "Invite not found", "INVITE_NOT_FOUND");
  if (invite.status !== "pending") throw new HttpError(409, `This invite was already ${invite.status}`, "INVITE_CLOSED");
  return invite;
}

async function sendInvite(invite: StaffInviteDocument, token: string, inviterId: string) {
  const inviter = await StaffModel.findById(inviterId).select("name");
  await sendStaffInviteEmail(invite.email, {
    inviterName: inviter?.name ?? "A LinkPay admin",
    roleLabel: staffRoleLabel(invite.role),
    link: staffInviteLink(token),
  });
}

// ---- Roles ----

/** Any signed-in staff member can read the roles, so the console can label them. */
export const listStaffRoles: RequestHandler = async (_req, res) => {
  res.json(
    STAFF_ROLES.map((role) => ({
      role,
      label: STAFF_ROLE_DETAILS[role].label,
      description: STAFF_ROLE_DETAILS[role].description,
      permissions: STAFF_ROLE_DETAILS[role].permissions,
    })),
  );
};

// ---- Staff ----

export const listStaff: RequestHandler = async (req, res) => {
  const staff = await StaffModel.find().sort({ createdAt: 1 });
  res.json(await serializeStaffList(staff, req.staffId!));
};

export const updateStaff: RequestHandler<IdParams> = async (req, res) => {
  const body = z.object({ role: z.unknown() }).parse(req.body);
  const role = parseStaffRole(body.role);
  const staff = await findOtherStaff(req);
  await assertKeepsASuperAdmin(staff, { role });
  const changed = staff.role !== role;
  const previous = staff.role;
  staff.role = role;
  await staff.save();
  if (changed) {
    const actor = await staffActor(req);
    // Audited before telling them, so the change is on record whatever happens next.
    await audit(actor, {
      action: "staff.role_changed",
      target: { kind: "staff", id: staff._id },
      summary: `Changed ${staff.name}'s role from ${staffRoleLabel(previous)} to ${staffRoleLabel(role)}`,
      details: { from: previous, to: role },
    });
    await staffRoleChanged(staff._id, role, actor.name);
  }
  res.json((await serializeStaffList([staff], req.staffId!))[0]);
};

export const disableStaff: RequestHandler<IdParams> = async (req, res) => {
  const staff = await findOtherStaff(req);
  await assertKeepsASuperAdmin(staff, { status: "disabled" });
  staff.status = "disabled";
  await staff.save();
  await revokeStaffSessions(staff._id);
  await audit(await staffActor(req), { action: "staff.disabled", target: { kind: "staff", id: staff._id }, summary: `Turned off ${staff.name}'s access` });
  res.json((await serializeStaffList([staff], req.staffId!))[0]);
};

export const enableStaff: RequestHandler<IdParams> = async (req, res) => {
  const staff = await findOtherStaff(req);
  staff.status = "active";
  await staff.save();
  await audit(await staffActor(req), { action: "staff.enabled", target: { kind: "staff", id: staff._id }, summary: `Turned on ${staff.name}'s access` });
  res.json((await serializeStaffList([staff], req.staffId!))[0]);
};

export const signOutStaff: RequestHandler<IdParams> = async (req, res) => {
  const staff = await findOtherStaff(req);
  await revokeStaffSessions(staff._id);
  await audit(await staffActor(req), { action: "staff.signed_out", target: { kind: "staff", id: staff._id }, summary: `Signed ${staff.name} out everywhere` });
  res.status(204).end();
};

// ---- Invites ----

/** Open invites only: not accepted, revoked or expired. */
export const listStaffInvites: RequestHandler = async (_req, res) => {
  const invites = await StaffInviteModel.find({ status: "pending", expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
  res.json(await serializeInvites(invites));
};

export const createStaffInvite: RequestHandler = async (req, res) => {
  const body = z.object({ email: z.email().trim().toLowerCase(), role: z.unknown() }).parse(req.body);
  const role = parseStaffRole(body.role);

  if (await StaffModel.exists({ email: body.email })) {
    throw new HttpError(409, "This person is already a staff member", "ALREADY_STAFF");
  }
  const pending = await StaffInviteModel.findOne({ email: body.email, status: "pending" });
  if (pending) {
    if (staffInviteStatus(pending) === "pending") {
      throw new HttpError(409, "This person already has an open invite. Resend it instead.", "INVITE_EXISTS");
    }
    // Expired: close it so a fresh one can take its place.
    pending.set({ status: "revoked", revokedAt: new Date() });
    await pending.save();
  }

  const token = newStaffInviteToken();
  const invite = await StaffInviteModel.create({
    email: body.email,
    role,
    invitedBy: req.staffId,
    tokenHash: hashStaffInviteToken(token),
    expiresAt: new Date(Date.now() + STAFF_INVITE_TTL_MS),
    lastSentAt: new Date(),
  }).catch((err) => {
    if (err?.code === 11000) throw new HttpError(409, "This person already has an open invite. Resend it instead.", "INVITE_EXISTS");
    throw err;
  });
  // Audited before sending: the invite exists either way. A failed send still fails the request, since the
  // email is the only way the link reaches them, and the invite can be resent.
  await audit(await staffActor(req), {
    action: "staff.invited",
    target: { kind: "staff_invite", id: invite._id },
    summary: `Invited ${invite.email} as ${staffRoleLabel(role)}`,
    details: { email: invite.email, role },
  });
  await sendInvite(invite, token, req.staffId!);
  res.status(201).json((await serializeInvites([invite]))[0]);
};

/** Sends a fresh link (the old one stops working) and restarts the 7-day expiry. */
export const resendStaffInvite: RequestHandler<IdParams> = async (req, res) => {
  const invite = await findPendingInvite(req.params.id);
  const retryAt = new Date(invite.lastSentAt.getTime() + STAFF_INVITE_RESEND_COOLDOWN_MS);
  if (retryAt.getTime() > Date.now()) {
    res.setHeader("Retry-After", Math.ceil((retryAt.getTime() - Date.now()) / 1000));
    throw new HttpError(429, "Please wait a minute before resending", "INVITE_COOLDOWN", { retryAt: retryAt.toISOString() });
  }

  const token = newStaffInviteToken();
  invite.set({ tokenHash: hashStaffInviteToken(token), expiresAt: new Date(Date.now() + STAFF_INVITE_TTL_MS), lastSentAt: new Date() });
  await invite.save();
  await sendInvite(invite, token, req.staffId!);
  res.json((await serializeInvites([invite]))[0]);
};

export const revokeStaffInvite: RequestHandler<IdParams> = async (req, res) => {
  const invite = await findPendingInvite(req.params.id);
  invite.set({ status: "revoked", revokedAt: new Date() });
  await invite.save();
  await audit(await staffActor(req), {
    action: "staff.invite_revoked",
    target: { kind: "staff_invite", id: invite._id },
    summary: `Cancelled the invite for ${invite.email}`,
  });
  res.status(204).end();
};
