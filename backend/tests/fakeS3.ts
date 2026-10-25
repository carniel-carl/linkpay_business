// A stand-in S3 on 127.0.0.1 for the storage, boot and preflight tests: path-style PUT, GET, HEAD and DELETE of
// /<bucket>/<key>, and ListObjectsV2 (GET /<bucket>/?list-type=2). It checks the access key id in the signature
// (not the signature itself) and answers with S3's XML errors. Every request is recorded.

/**
 * Bun.serve on a port outside the range the OS hands out for port 0 (49152 and up on macOS, 32768 and up on Linux).
 * An app server a suite stopped earlier in this process can leave keep-alive connections open, and fetch and Bun's
 * S3 client reuse a connection by host and port: a stand-in that got the same port could be answered by that old
 * server instead (a 426 from its app-version check, say).
 */
export function serveStandIn(options: Omit<Parameters<typeof Bun.serve>[0], "port">) {
  for (let attempt = 1; ; attempt++) {
    try {
      return Bun.serve({ ...options, port: 20_000 + Math.floor(Math.random() * 12_000) } as Parameters<typeof Bun.serve>[0]);
    } catch (err) {
      if (attempt >= 20 || (err as { code?: string }).code !== "EADDRINUSE") throw err;
    }
  }
}

export const FAKE_S3_KEYS = { accessKeyId: "AKIAFAKES3TEST", secretAccessKey: `fake-s3-secret-${crypto.randomUUID()}` };

export type FakeS3Request = { method: string; path: string; query: string; authorization: string; acl: string | null; contentType: string | null };
export type FakeS3 = ReturnType<typeof startFakeS3>;

const xml = (status: number, body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { status, headers: { "Content-Type": "application/xml" } });
const s3Error = (status: number, code: string) => xml(status, `<Error><Code>${code}</Code><Message>${code} (fake S3)</Message></Error>`);
const escape = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

export function startFakeS3({
  bucket = "linkpay-test",
  /** How DELETE answers for a key that isn't there: S3's 204, or the NoSuchKey some services send. */
  deleteMissing = "204" as "204" | "NoSuchKey",
  /** Refuse listing, as a key without s3:ListBucket gets. */
  denyList = false,
} = {}) {
  const objects = new Map<string, Uint8Array>();
  const requests: FakeS3Request[] = [];
  const server = serveStandIn({
    async fetch(req) {
      const url = new URL(req.url);
      const [, name = "", ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      requests.push({
        method: req.method,
        path: url.pathname,
        query: url.search,
        authorization: req.headers.get("authorization") ?? "",
        acl: req.headers.get("x-amz-acl"),
        contentType: req.headers.get("content-type"),
      });
      if (!req.headers.get("authorization")?.startsWith(`AWS4-HMAC-SHA256 Credential=${FAKE_S3_KEYS.accessKeyId}/`)) return s3Error(403, "InvalidAccessKeyId");
      if (name !== bucket) return s3Error(404, "NoSuchBucket");

      if (req.method === "GET" && !key && url.searchParams.get("list-type") === "2") {
        if (denyList) return s3Error(403, "AccessDenied");
        const prefix = url.searchParams.get("prefix") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const shown = keys.slice(0, max);
        const contents = shown.map((k) => `<Contents><Key>${escape(k)}</Key><Size>${objects.get(k)!.length}</Size></Contents>`).join("");
        return xml(
          200,
          `<ListBucketResult><Name>${bucket}</Name><Prefix>${escape(prefix)}</Prefix><KeyCount>${shown.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${keys.length > max}</IsTruncated>${contents}</ListBucketResult>`,
        );
      }
      switch (req.method) {
        case "PUT":
          objects.set(key, new Uint8Array(await req.arrayBuffer()));
          return new Response(null, { status: 200, headers: { ETag: '"fake"' } });
        case "GET":
        case "HEAD": {
          const data = objects.get(key);
          if (!data) return req.method === "HEAD" ? new Response(null, { status: 404 }) : s3Error(404, "NoSuchKey");
          const headers = { "Content-Length": String(data.length), ETag: '"fake"', "Last-Modified": new Date().toUTCString() };
          return new Response(req.method === "HEAD" ? null : data, { headers });
        }
        case "DELETE":
          if (!objects.delete(key) && deleteMissing === "NoSuchKey") return s3Error(404, "NoSuchKey");
          return new Response(null, { status: 204 });
        default:
          return s3Error(405, "MethodNotAllowed");
      }
    },
  });
  return { bucket, objects, requests, url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
