// The email and file-storage settings, read from a set of variables. env.ts reads them from process.env at boot (a
// bad value stops it); scripts/preflight.ts reads the same rules from the variables it's given, before env.ts loads.
// Nothing here reads the environment itself or calls anything. src/services/providers.ts wires what they name.

type Vars = Record<string, string | undefined>;

/** One of `options` (the first when unset or empty). Anything else stops the boot: a typo would fall back silently. */
function choice<T extends string>(vars: Vars, name: string, options: readonly T[]): T {
  const raw = vars[name]?.trim();
  if (!raw) return options[0]!;
  if ((options as readonly string[]).includes(raw)) return raw as T;
  throw new Error(`${name} must be ${options.slice(0, -1).join(", ")} or ${options.at(-1)}, not "${vars[name]}".`);
}

// ---------------------------------------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------------------------------------

const LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";
/** A plain address (no quoted local part, no IP literal); the domain is captured. */
const ADDRESS = new RegExp(`^[^\\s@<>()",;:\\\\\\[\\]]{1,64}@((?:${LABEL}\\.)+[A-Za-z][A-Za-z0-9-]{0,61}[A-Za-z0-9])$`);
/** A display name in double quotes, or one without the punctuation that would need them. */
const DISPLAY_NAME = /^(?:"[^"\\\r\n]{1,100}"|[^"(),:;<>@[\]\\\r\n\t]{1,100})$/;

export type Mailbox = { value: string; address: string; domain: string };

/** "no-reply@mail.example.com" or "LinkPay Business <no-reply@mail.example.com>". */
export function mailbox(name: string, raw: string): Mailbox {
  const value = raw.trim();
  const angle = value.match(/^(.*?)\s*<([^<>]*)>$/s);
  const display = angle ? angle[1]!.trim() : "";
  const address = (angle ? angle[2]! : value).trim();
  const domain = address.length <= 254 ? address.match(ADDRESS)?.[1] : undefined;
  if (!domain || (display && !DISPLAY_NAME.test(display))) {
    throw new Error(
      `${name} must be an address such as no-reply@mail.example.com, or a name and an address such as ` +
        `"LinkPay Business <no-reply@mail.example.com>" (a name with commas or other punctuation goes in double quotes), not "${raw}".`,
    );
  }
  return { value: display ? `${display} <${address}>` : address, address, domain: domain.toLowerCase() };
}

export type EmailSettings =
  /** Prints every email, sign-in codes included, to the log. index.ts refuses it in production or with a live key. */
  | { provider: "console"; replyTo?: string }
  | {
      provider: "resend";
      apiKey: string;
      /** As Resend gets it: an address, or a name and an address. */
      from: string;
      /** EMAIL_FROM's domain, which must be verified in Resend. */
      fromDomain: string;
      /** Where replies go when an email doesn't say (invoices reply to the business). */
      replyTo?: string;
    };

export function emailSettings(vars: Vars): EmailSettings {
  const provider = choice(vars, "EMAIL_PROVIDER", ["console", "resend"] as const);
  // Checked whatever the provider: a bad address is a bad address.
  const from = vars.EMAIL_FROM?.trim() ? mailbox("EMAIL_FROM", vars.EMAIL_FROM) : undefined;
  const replyTo = vars.EMAIL_REPLY_TO?.trim() ? mailbox("EMAIL_REPLY_TO", vars.EMAIL_REPLY_TO).value : undefined;
  if (provider === "console") return { provider, replyTo };

  // The key is never repeated in a message.
  const apiKey = vars.RESEND_API_KEY?.trim();
  if (!apiKey) throw new Error("EMAIL_PROVIDER=resend needs RESEND_API_KEY, an API key from resend.com/api-keys (a sending-only key is enough).");
  if (!/^re_\S+$/.test(apiKey)) throw new Error("RESEND_API_KEY isn't a Resend API key: those start with re_ (the value isn't shown here).");
  if (!from) {
    throw new Error('EMAIL_PROVIDER=resend needs EMAIL_FROM, an address on a domain verified in Resend, such as "LinkPay Business <no-reply@mail.example.com>".');
  }
  return { provider, apiKey, from: from.value, fromDomain: from.domain, replyTo };
}

// ---------------------------------------------------------------------------------------------------------
// File storage
// ---------------------------------------------------------------------------------------------------------

export const S3_REQUIRED = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const;
export const S3_VARS = [...S3_REQUIRED, "S3_ENDPOINT", "S3_PREFIX"] as const;

export type S3Settings = {
  provider: "s3";
  bucket: string;
  region: string;
  /** The service's origin (R2, Spaces, MinIO). Unset: AWS's endpoint for the region. */
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** "" or a folder ending in "/", put before every key. */
  prefix: string;
};

/** "local" keeps files in UPLOAD_DIR (env.uploadDir). */
export type StorageSettings = { provider: "local" } | S3Settings;

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;

/** The endpoint's origin. Plain http only outside production, or to this machine (a MinIO beside the API). */
function s3Endpoint(raw: string, production: boolean) {
  // Credentials never belong in it, and are never repeated.
  const shown = raw.replace(/\/\/[^/@]*@/, "//…@");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`S3_ENDPOINT must be a URL such as https://<account id>.r2.cloudflarestorage.com, not "${shown}".`);
  }
  if (url.username || url.password) throw new Error("S3_ENDPOINT must not hold credentials: they go in S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY.");
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`S3_ENDPOINT must start with https://, not "${shown}".`);
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(
      `S3_ENDPOINT must be the service's address alone, such as https://<account id>.r2.cloudflarestorage.com, not "${shown}": the bucket goes in S3_BUCKET and a folder in S3_PREFIX.`,
    );
  }
  if (url.protocol === "http:" && production && !LOOPBACK.test(url.hostname)) {
    throw new Error(`S3_ENDPOINT is plain http with NODE_ENV=production, so files (verification documents among them) would cross the network unencrypted: use https://.`);
  }
  return url.origin;
}

export function storageSettings(vars: Vars): StorageSettings {
  const provider = choice(vars, "STORAGE_PROVIDER", ["local", "s3"] as const);
  if (provider === "local") return { provider };

  const value = (name: string) => vars[name]?.trim() || undefined;
  const missing = S3_REQUIRED.filter((name) => !value(name));
  if (missing.length) throw new Error(`STORAGE_PROVIDER=s3 needs ${S3_REQUIRED.join(", ")}; missing: ${missing.join(", ")}.`);

  const bucket = value("S3_BUCKET")!;
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new Error(`S3_BUCKET must be a bucket name (3 to 63 lowercase letters, digits, dots and hyphens, starting and ending with a letter or digit), not "${vars.S3_BUCKET}".`);
  }
  const region = value("S3_REGION")!;
  if (!/^[a-z0-9-]{1,32}$/.test(region)) throw new Error(`S3_REGION must be a region such as eu-west-2 (auto for R2), not "${vars.S3_REGION}".`);

  const endpointRaw = value("S3_ENDPOINT");
  const endpoint = endpointRaw ? s3Endpoint(endpointRaw, vars.NODE_ENV === "production") : undefined;

  let prefix = "";
  const prefixRaw = value("S3_PREFIX");
  if (prefixRaw) {
    const folder = prefixRaw.replace(/\/+$/, "");
    if (!/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(folder) || folder.split("/").some((s) => s === "." || s === "..")) {
      throw new Error(`S3_PREFIX must be a folder such as linkpay/production (letters, digits, . _ - and /, not starting with /), not "${vars.S3_PREFIX}".`);
    }
    prefix = `${folder}/`;
  }
  return { provider, bucket, region, endpoint, accessKeyId: value("S3_ACCESS_KEY_ID")!, secretAccessKey: value("S3_SECRET_ACCESS_KEY")!, prefix };
}

/** `S3 bucket "linkpay-files" at endpoint https://….r2.cloudflarestorage.com (region auto, prefix "production/")`. No secrets. */
export function describeS3(s: S3Settings) {
  const prefix = s.prefix ? `prefix "${s.prefix}"` : "no prefix";
  return s.endpoint
    ? `S3 bucket "${s.bucket}" at endpoint ${s.endpoint} (region ${s.region}, ${prefix})`
    : `S3 bucket "${s.bucket}" at AWS's endpoint for ${s.region} (${prefix})`;
}
