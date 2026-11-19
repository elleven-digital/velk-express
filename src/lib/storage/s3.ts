import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { pipeline } from "node:stream/promises";
import { PassThrough, type Readable } from "node:stream";
import type { S3Config } from "../config";
import { assertSafeKey } from "./keys";
import { byteLimiter, TooLargeError, type Storage } from "./types";

function makeClient(cfg: S3Config): S3Client {
  return new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true, // MinIO, R2 and most S3-compatible services need path-style URLs
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
}

function isMissing(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

export function s3Storage(cfg: S3Config): Storage {
  const client = makeClient(cfg);
  const Bucket = cfg.bucket;

  return {
    async put(key, body, contentType) {
      assertSafeKey(key);
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },

    async putStream(key, body, contentType, { maxBytes }) {
      assertSafeKey(key);
      const limiter = byteLimiter(maxBytes);
      const through = new PassThrough();
      const upload = new Upload({
        client,
        queueSize: 1,
        partSize: 5 * 1024 * 1024,
        leavePartsOnError: false,
        params: { Bucket, Key: key, Body: through, ContentType: contentType },
      });
      const piping = pipeline(body, limiter, through);
      try {
        // Whichever side fails first wins; then the other is stopped.
        await Promise.all([piping, upload.done()]);
      } catch (err) {
        body.destroy();
        through.destroy();
        await upload.abort().catch(() => undefined);
        await piping.catch(() => undefined);
        // A multipart upload is dropped by abort; a single-part one never completed.
        // Delete defensively in case the object was committed before the failure surfaced.
        await client.send(new DeleteObjectCommand({ Bucket, Key: key })).catch(() => undefined);
        // When the limit tripped, that is the root cause whatever the upload reported.
        if (limiter.bytes() > maxBytes) throw new TooLargeError();
        throw err;
      }
      return { size: limiter.bytes() };
    },

    async get(key) {
      assertSafeKey(key);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket, Key: key }));
        if (!res.Body) return null;
        return {
          stream: res.Body as Readable,
          contentType: res.ContentType ?? null,
          size: res.ContentLength ?? null,
        };
      } catch (err) {
        if (isMissing(err)) return null;
        throw err;
      }
    },

    async remove(key) {
      assertSafeKey(key);
      try {
        await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
      } catch (err) {
        if (!isMissing(err)) throw err;
      }
    },
  };
}

/** True when the bucket answers a HeadBucket call. Never throws. */
export async function s3BucketReachable(cfg: S3Config): Promise<boolean> {
  try {
    await makeClient(cfg).send(new HeadBucketCommand({ Bucket: cfg.bucket }));
    return true;
  } catch {
    return false;
  }
}
