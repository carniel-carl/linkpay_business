// The S3 FileStorage in src/services/storage.ts against a stand-in S3 on 127.0.0.1 (path-style PUT, GET, HEAD,
// DELETE and a one-key list): a round trip, the prefix, and a missing object behaving as a missing local file
// does. No real bucket is ever used. tests/fakeS3.ts is shared with the boot and preflight tests.
import { afterAll, describe, expect, test } from "bun:test";
import type { S3Settings } from "../src/config/providerSettings";
import { createS3Storage, readFile, removeFile, usingLocalStorage } from "../src/services/storage";
import { FAKE_S3_KEYS, serveStandIn, startFakeS3, type FakeS3 } from "./fakeS3";

const fakes: FakeS3[] = [];
afterAll(() => {
  for (const f of fakes) f.stop();
});

function bucket(options?: Parameters<typeof startFakeS3>[0]) {
  const fake = startFakeS3(options);
  fakes.push(fake);
  const settings = (overrides: Partial<S3Settings> = {}): S3Settings => ({
    provider: "s3",
    bucket: fake.bucket,
    region: "auto",
    endpoint: fake.url,
    ...FAKE_S3_KEYS,
    prefix: "",
    ...overrides,
  });
  return { fake, settings };
}

describe("S3 storage", () => {
  test("a round trip under the prefix: no ACL, stored as octet-stream, signed with the key id and never the secret", async () => {
    const { fake, settings } = bucket();
    const storage = createS3Storage(settings({ prefix: "linkpay/production/" }));
    const data = Buffer.from("%PDF-1.7 certificate of incorporation");

    await storage.save("kyb/biz_1/doc_1.pdf", data);
    expect([...fake.objects.keys()]).toEqual(["linkpay/production/kyb/biz_1/doc_1.pdf"]);
    const put = fake.requests.find((r) => r.method === "PUT")!;
    expect(put.path).toBe(`/${fake.bucket}/linkpay/production/kyb/biz_1/doc_1.pdf`);
    expect(put.contentType).toBe("application/octet-stream");
    expect(put.acl).toBeNull(); // as private as the bucket
    expect(put.authorization).toStartWith(`AWS4-HMAC-SHA256 Credential=${FAKE_S3_KEYS.accessKeyId}/`);
    for (const r of fake.requests) expect(JSON.stringify(r)).not.toContain(FAKE_S3_KEYS.secretAccessKey);

    expect((await storage.read("kyb/biz_1/doc_1.pdf")).equals(data)).toBe(true);
    await storage.remove("kyb/biz_1/doc_1.pdf");
    expect(fake.objects.size).toBe(0);
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      `PUT /${fake.bucket}/linkpay/production/kyb/biz_1/doc_1.pdf`,
      `GET /${fake.bucket}/linkpay/production/kyb/biz_1/doc_1.pdf`,
      `DELETE /${fake.bucket}/linkpay/production/kyb/biz_1/doc_1.pdf`,
    ]);
    expect(storage.name).toBe(`S3 bucket "${fake.bucket}" at endpoint ${fake.url} (region auto, prefix "linkpay/production/")`);
  });

  test("without a prefix the keys are used as they are", async () => {
    const { fake, settings } = bucket();
    const storage = createS3Storage(settings());
    await storage.save("branding/biz_1/logo-ab12.png", Buffer.from("png"));
    expect([...fake.objects.keys()]).toEqual(["branding/biz_1/logo-ab12.png"]);
    expect(storage.name).toContain("no prefix");
  });

  test("a missing object reads as a missing local file does: rejected with code ENOENT; removing it does nothing", async () => {
    // The local storage the tests run on, for comparison.
    expect(usingLocalStorage()).toBe(true);
    const local = await readFile("kyb/nobody/missing.pdf").catch((err) => err);
    expect(local.code).toBe("ENOENT");
    await removeFile("kyb/nobody/missing.pdf");

    for (const deleteMissing of ["204", "NoSuchKey"] as const) {
      const { settings } = bucket({ deleteMissing });
      const storage = createS3Storage(settings({ prefix: "p/" }));
      const err = await storage.read("kyb/nobody/missing.pdf").catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe("ENOENT");
      expect(err.message).toContain("kyb/nobody/missing.pdf");
      // What branding.ts and paymentLinkImages.ts do with a missing file.
      expect(await storage.read("kyb/nobody/missing.pdf").catch(() => null)).toBeNull();
      await storage.remove("kyb/nobody/missing.pdf"); // S3 says 204; some services say NoSuchKey
    }
  });

  test("other failures stay failures: wrong keys, a missing bucket, an unreachable endpoint", async () => {
    const { settings } = bucket();
    const wrongKeys = createS3Storage(settings({ accessKeyId: "AKIAWRONG" }));
    const err = await wrongKeys.read("kyb/x.pdf").catch((e) => e);
    expect(err.code).toBe("InvalidAccessKeyId");
    expect(await wrongKeys.save("kyb/x.pdf", Buffer.from("x")).catch((e) => e.code)).toBe("InvalidAccessKeyId");
    expect(await wrongKeys.remove("kyb/x.pdf").catch((e) => e.code)).toBe("InvalidAccessKeyId");

    expect(await createS3Storage(settings({ bucket: "no-such-bucket" })).read("kyb/x.pdf").catch((e) => e.code)).toBe("NoSuchBucket");
    expect(await createS3Storage(settings({ endpoint: "http://127.0.0.1:1" })).read("kyb/x.pdf").catch((e) => e.code)).toBe("ConnectionRefused");
  });

  test("a bucket that never answers fails each call after the timeout instead of hanging", async () => {
    const { settings } = bucket();
    const silent = serveStandIn({ fetch: () => new Promise<Response>(() => {}) });
    try {
      const storage = createS3Storage(settings({ endpoint: `http://127.0.0.1:${silent.port}` }), undefined, { timeoutMs: 200 });
      for (const call of [() => storage.save("kyb/x.pdf", Buffer.from("x")), () => storage.read("kyb/x.pdf"), () => storage.remove("kyb/x.pdf")]) {
        const started = Date.now();
        const err = await call().catch((e) => e);
        expect(err.code).toBe("ETIMEDOUT");
        expect(Date.now() - started).toBeLessThan(2_000);
      }
    } finally {
      silent.stop(true);
    }
  });
});
