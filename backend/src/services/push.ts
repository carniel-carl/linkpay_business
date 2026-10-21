import { env } from "../config/env";
import { PushTokenModel } from "../models/PushToken";
import { SessionModel } from "../models/Session";

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  /** Read by the mobile app when the push is tapped (notification id, type, ids to open). */
  data: Record<string, unknown>;
  /** Android notification channel (ignored on iOS). */
  channelId?: string;
}

export interface PushProvider {
  /** Returns the tokens the push service says are no longer valid, so they can be forgotten. */
  send(messages: PushMessage[]): Promise<{ invalidTokens: string[] }>;
}

// Default until PUSH_PROVIDER=expo: prints pushes to the console, like emails.
const consolePushProvider: PushProvider = {
  async send(messages) {
    for (const m of messages) console.log(`\n📱 Push to ${m.to}\n${m.title}\n${m.body}\n`);
    return { invalidTokens: [] };
  },
};

/** Expo's push service, which delivers to APNs (iOS) and FCM (Android). */
export const expoPushProvider: PushProvider = {
  async send(messages) {
    const invalidTokens: string[] = [];
    // Expo takes at most 100 messages per request.
    for (let i = 0; i < messages.length; i += 100) {
      const chunk = messages.slice(i, i + 100);
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(env.expoAccessToken && { Authorization: `Bearer ${env.expoAccessToken}` }),
        },
        body: JSON.stringify(chunk.map((m) => ({ ...m, sound: "default", priority: "high" }))),
      });
      if (!res.ok) throw new Error(`Expo push failed: ${res.status} ${await res.text()}`);
      const { data } = (await res.json()) as { data: { status: string; details?: { error?: string } }[] };
      data.forEach((ticket, j) => {
        if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") invalidTokens.push(chunk[j]!.to);
      });
    }
    return { invalidTokens };
  },
};

let provider: PushProvider = env.pushProvider === "expo" ? expoPushProvider : consolePushProvider;

/** Swap the push provider (tests use a capture provider). */
export function setPushProvider(next: PushProvider) {
  provider = next;
}

/** Phones where this user is still signed in. Tokens from ended sessions are forgotten. */
async function activeTokens(userIds: string[]) {
  const tokens = await PushTokenModel.find({ user: { $in: userIds } }).select("user token session").lean();
  const sessionIds = tokens.flatMap((t) => (t.session ? [t.session] : []));
  const live = new Set(
    (await SessionModel.find({ _id: { $in: sessionIds }, revokedAt: null, expiresAt: { $gt: new Date() } }).select("_id").lean()).map((s) =>
      String(s._id),
    ),
  );
  const [ok, stale] = [tokens.filter((t) => !t.session || live.has(String(t.session))), tokens.filter((t) => t.session && !live.has(String(t.session)))];
  if (stale.length) await PushTokenModel.deleteMany({ _id: { $in: stale.map((t) => t._id) } });
  return ok;
}

/** Sends one push per phone of each user. Errors are logged, never thrown. */
export async function pushToUsers(pushes: { userId: string; title: string; body: string; data: Record<string, unknown>; channelId?: string }[]) {
  try {
    if (!pushes.length) return;
    const tokens = await activeTokens([...new Set(pushes.map((p) => p.userId))]);
    const messages = pushes.flatMap((p) =>
      tokens
        .filter((t) => String(t.user) === p.userId)
        .map((t) => ({ to: t.token, title: p.title, body: p.body, data: p.data, ...(p.channelId && { channelId: p.channelId }) })),
    );
    if (!messages.length) return;
    const { invalidTokens } = await provider.send(messages);
    if (invalidTokens.length) await PushTokenModel.deleteMany({ token: { $in: invalidTokens } });
  } catch (err) {
    console.error("Couldn't send push notifications:", err);
  }
}
