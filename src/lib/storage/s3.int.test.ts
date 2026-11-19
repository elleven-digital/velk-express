import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { s3Storage } from "./s3";
import { TooLargeError } from "./types";

// Runs only against a real S3-compatible bucket (for example a local MinIO):
//   S3_TEST_ENDPOINT, S3_TEST_BUCKET, S3_TEST_ACCESS_KEY_ID, S3_TEST_SECRET_ACCESS_KEY
// The bucket must already exist. Without S3_TEST_ENDPOINT the suite is skipped.
const endpoint = process.env.S3_TEST_ENDPOINT;

const MB = 1024 * 1024;
const chunks = (count: number, chunk: Buffer) => Readable.from((function* () { for (let i = 0; i < count; i += 1) yield chunk; })());
const sha = (buf: Buffer) => createHash("sha256").update(buf).digest("hex");

async function readAll(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of stream) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}

describe.skipIf(!endpoint)("s3Storage against a real bucket", () => {
  const storage = s3Storage({
    endpoint: endpoint ?? "",
    region: "us-east-1",
    bucket: process.env.S3_TEST_BUCKET ?? "",
    accessKeyId: process.env.S3_TEST_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_TEST_SECRET_ACCESS_KEY ?? "",
  });
  const used: string[] = [];
  const keyFor = (name: string) => {
    const key = `attachments/s3-test-${Date.now()}-${name}`;
    used.push(key);
    return key;
  };

  afterAll(async () => {
    await Promise.all(used.map((key) => storage.remove(key)));
  });

  it("round-trips a small body", async () => {
    const key = keyFor("small");
    const body = randomBytes(300 * 1024);
    const { size } = await storage.putStream(key, Readable.from([body]), "application/pdf", { maxBytes: 25 * MB });
    expect(size).toBe(body.length);
    const got = await storage.get(key);
    expect(got?.contentType).toBe("application/pdf");
    expect(sha(await readAll(got!.stream))).toBe(sha(body));
  });

  it("round-trips a multipart body byte for byte", async () => {
    const key = keyFor("multipart");
    const chunk = randomBytes(MB);
    const { size } = await storage.putStream(key, chunks(12, chunk), "application/octet-stream", { maxBytes: 25 * MB });
    expect(size).toBe(12 * MB);
    const got = await storage.get(key);
    expect(sha(await readAll(got!.stream))).toBe(sha(Buffer.concat(Array.from({ length: 12 }, () => chunk))));
  });

  it("rejects an over-limit multipart body and leaves no object", async () => {
    const key = keyFor("too-large");
    await expect(
      storage.putStream(key, chunks(12, randomBytes(MB)), "application/octet-stream", { maxBytes: 7 * MB }),
    ).rejects.toBeInstanceOf(TooLargeError);
    expect(await storage.get(key)).toBeNull();
  });
});
