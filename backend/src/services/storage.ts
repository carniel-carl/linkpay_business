import path from "node:path";
import { describeS3, type S3Settings } from "../config/providerSettings";
import { env } from "../config/env";

export interface FileStorage {
  save(key: string, data: Buffer): Promise<void>;
  /** Rejects when there's no such file, as Bun.file does (code ENOENT). */
  read(key: string): Promise<Buffer>;
  /** Removing a file that isn't there does nothing. */
  remove(key: string): Promise<void>;
  /** For startup logs and preflight. Never a secret. */
  name?: string;
}

// Local disk: development, or production with UPLOAD_DIR on a persistent volume. STORAGE_PROVIDER=s3 swaps in the
// bucket below (src/services/providers.ts).
const localStorage: FileStorage = {
  get name() {
    return `local disk at ${path.resolve(env.uploadDir)}`;
  },
  async save(key, data) {
    await Bun.write(path.join(env.uploadDir, key), data);
  },
  async read(key) {
    return Buffer.from(await Bun.file(path.join(env.uploadDir, key)).arrayBuffer());
  },
  async remove(key) {
    const file = Bun.file(path.join(env.uploadDir, key));
    if (await file.exists()) await file.delete();
  },
};

// ---------------------------------------------------------------------------------------------------------
// S3-compatible bucket (AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO) through Bun.S3Client, path-style.
// Objects are written without an ACL, so they're as private as the bucket (keep public access blocked), and
// they're stored as application/octet-stream: the API sends every file itself, with its own type.
// ---------------------------------------------------------------------------------------------------------

export const s3Client = (s: S3Settings) =>
  new Bun.S3Client({ bucket: s.bucket, region: s.region, endpoint: s.endpoint, accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey });

/** Bun's code for a missing object (any 404). Without s3:ListBucket, S3 answers 403 AccessDenied instead, which stays an error. */
const isMissing = (err: unknown) => (err as { code?: unknown } | null)?.code === "NoSuchKey";

/** Bun.S3Client has no timeout of its own: a bucket that stops answering would hold the request open for good. */
export const S3_TIMEOUT_MS = 30_000;

export function createS3Storage(settings: S3Settings, client = s3Client(settings), { timeoutMs = S3_TIMEOUT_MS } = {}): FileStorage {
  const objectKey = (key: string) => `${settings.prefix}${key}`;
  // The call itself can't be cancelled, so a late answer is dropped; the caller gets an error it can report.
  const timed = <T>(what: string, work: Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`File storage didn't answer within ${timeoutMs / 1000} s (${what})`), { code: "ETIMEDOUT" })), timeoutMs);
    });
    return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
  };
  return {
    name: describeS3(settings),
    async save(key, data) {
      await timed("save", client.write(objectKey(key), data, { type: "application/octet-stream" }));
    },
    async read(key) {
      try {
        return Buffer.from(await timed("read", client.file(objectKey(key)).arrayBuffer()));
      } catch (err) {
        // As a missing local file: callers tell "not there" from other failures by the code alone.
        if (isMissing(err)) throw Object.assign(new Error(`ENOENT: no such file in the bucket: ${key}`), { code: "ENOENT" });
        throw err;
      }
    },
    async remove(key) {
      // S3 answers 204 for a key that isn't there; some compatible services say NoSuchKey instead.
      await timed("remove", client.delete(objectKey(key))).catch((err) => {
        if (!isMissing(err)) throw err;
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------------------

let storage: FileStorage = localStorage;

/** Swaps in other storage at startup: src/services/providers.ts does, from STORAGE_PROVIDER. */
export function setFileStorage(next: FileStorage) {
  storage = next;
}

export const usingLocalStorage = () => storage === localStorage;
export const fileStorageName = () => storage.name;

export const saveFile = (key: string, data: Buffer) => storage.save(key, data);
export const readFile = (key: string) => storage.read(key);
export const removeFile = (key: string) => storage.remove(key);
