import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../config/env";

const key = Buffer.from(env.encryptionKey, "hex");
if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters)");

const IV_BYTES = 12;
// Always the full 16-byte GCM tag. Without a fixed length a decipher also takes a shortened tag, which is
// far easier to forge.
const TAG_BYTES = 16;
const V2 = "v2:";

/** Says what to do about an old-format value while ENCRYPTION_REQUIRE_V2=1 refuses them. */
const legacyRefused = () =>
  new Error(
    "Refusing an encrypted value in the old format (before v2): ENCRYPTION_REQUIRE_V2=1 is set. " +
      "Run `bun run migrate:encryption --apply` to rewrite old values, or unset ENCRYPTION_REQUIRE_V2.",
  );

/**
 * AES-256-GCM, in two formats:
 * - v2, written whenever a `context` is given: `v2:iv.tag.ciphertext` (base64url), with the context as
 *   additional data (AAD). The context names the record and field the value belongs to (e.g. `bvnContext`
 *   in models/Business.ts), so a value copied onto another record, or another field, doesn't decrypt there.
 * - Legacy, without a context: `iv.tag.ciphertext`, bound to nothing. Still readable so data written before
 *   v2 keeps working; `bun run migrate:encryption` rewrites it as v2. App code always passes a context.
 *   With ENCRYPTION_REQUIRE_V2=1 (set once the migration has run) the old format is refused both ways.
 */
export function encrypt(plain: string, context?: string): string {
  if (context === undefined && env.encryptionRequireV2) throw legacyRefused();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  if (context !== undefined) cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const body = [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
  return context === undefined ? body : V2 + body;
}

/** Written before v2 (no record binding); scripts/migrate-encryption.ts rewrites these. */
export const isLegacyCiphertext = (payload: string) => !payload.startsWith(V2);

/**
 * Reads either format. A v2 value only decrypts with the context it was written with; a legacy value ignores
 * the context, and is refused while ENCRYPTION_REQUIRE_V2=1 unless `allowLegacy` (the migration, which
 * rewrites it). Throws on anything damaged, shortened or moved.
 */
export function decrypt(payload: string, context?: string, { allowLegacy = false } = {}): string {
  const v2 = payload.startsWith(V2);
  if (!v2 && env.encryptionRequireV2 && !allowLegacy) throw legacyRefused();
  if (v2 && context === undefined) throw new Error("This encrypted value can only be read with its context");
  const parts = (v2 ? payload.slice(V2.length) : payload).split(".");
  if (parts.length !== 3) throw new Error("Malformed encrypted payload");
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, "base64url")) as [Buffer, Buffer, Buffer];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error("Malformed encrypted payload");
  const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  decipher.setAuthTag(tag);
  if (v2) decipher.setAAD(Buffer.from(context!, "utf8"));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** For the startup log: whether old-format values are still read. */
export const encryptionModeMessage = () =>
  env.encryptionRequireV2
    ? "Encryption: values in the old format (before v2) are refused (ENCRYPTION_REQUIRE_V2=1)."
    : "Encryption: values in the old format (before v2) are still read. Set ENCRYPTION_REQUIRE_V2=1 once `bun run migrate:encryption --apply` reports none left.";
