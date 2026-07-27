import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it, vi } from "vitest";
import { sealAccountErasureRestoreIntent } from "./restore-intent-codec.ts";
import { R2AccountErasureRestoreLedger } from "./restore-ledger.ts";

const userHash = "a".repeat(64);
const requestId = "10000000-0000-4000-8000-000000001994";
const statusToken = "a".repeat(43);

interface CapturedRequest {
  headers: Record<string, string>;
  hostname: string;
  method: string;
  path: string;
  query?: Record<string, string | string[] | null>;
}

function isCapturedRequest(value: unknown): value is CapturedRequest {
  return (
    value !== null &&
    typeof value === "object" &&
    "headers" in value &&
    value.headers !== null &&
    typeof value.headers === "object" &&
    "hostname" in value &&
    typeof value.hostname === "string" &&
    "method" in value &&
    typeof value.method === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

function makeClient(
  handler: (request: CapturedRequest) => Promise<{
    response: { body: Readable; headers: Record<string, string>; statusCode: number };
  }>,
) {
  return new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint: "https://account.r2.cloudflarestorage.com",
    region: "auto",
    requestHandler: {
      destroy: vi.fn(),
      handle: (request: unknown, _options?: unknown) => {
        if (!isCapturedRequest(request)) {
          throw new Error("Unexpected AWS request shape");
        }
        return handler(request);
      },
      metadata: { handlerProtocol: "http/1.1" },
      updateHttpClientConfig: vi.fn(),
      httpHandlerConfigs: vi.fn(() => ({})),
    },
  });
}

describe("R2AccountErasureRestoreLedger", () => {
  it("conditionally writes a pseudonymous durable intent", async () => {
    const requests: CapturedRequest[] = [];
    const client = makeClient(async (request) => {
      requests.push(request);
      return {
        response: { body: Readable.from(""), headers: {}, statusCode: 200 },
      };
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await ledger.recordIntent({
      keyId: "test-v1",
      requestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken,
      userHash,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers["if-none-match"]).toBe("*");
    expect(requests[0]?.path).toContain(
      `/account-erasure/v1/test-v1/${userHash}/${requestId}.json`,
    );
    expect(requests[0]?.hostname).toContain("erasure-ledger");
    expect(requests[0]?.path).not.toContain("erase@example");
  });

  it("treats an existing immutable intent as an idempotent success", async () => {
    const intent = {
      keyId: "test-v1",
      requestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken,
      userHash,
    };
    const client = makeClient(async (request) => ({
      response:
        request.method === "PUT"
          ? {
              body: Readable.from(""),
              headers: { "content-type": "application/xml" },
              statusCode: 412,
            }
          : {
              body: Readable.from(JSON.stringify(sealAccountErasureRestoreIntent(intent))),
              headers: { "content-type": "application/json" },
              statusCode: 200,
            },
    }));
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.recordIntent(intent)).resolves.toBeUndefined();
  });

  it("rejects a conflicting object at an immutable intent key", async () => {
    const intent = {
      keyId: "test-v1",
      requestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken,
      userHash,
    };
    const conflictingIntent = {
      ...intent,
      statusToken: "b".repeat(43),
    };
    const client = makeClient(async (request) => ({
      response:
        request.method === "PUT"
          ? {
              body: Readable.from(""),
              headers: { "content-type": "application/xml" },
              statusCode: 412,
            }
          : {
              body: Readable.from(
                JSON.stringify(sealAccountErasureRestoreIntent(conflictingIntent)),
              ),
              headers: { "content-type": "application/json" },
              statusCode: 200,
            },
    }));
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.recordIntent(intent)).rejects.toThrow(
      "conflicts with its immutable ledger entry",
    );
  });

  it("lists only the bounded prefixes for the supplied identities", async () => {
    const requests: CapturedRequest[] = [];
    const client = makeClient(async (request) => {
      requests.push(request);
      return {
        response: {
          body: Readable.from(
            '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>erasure-ledger</Name><Prefix></Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>',
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(
      ledger.listIntentsForIdentities([{ keyId: "test-v1", userHash }]),
    ).resolves.toEqual([]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.query?.prefix).toBe(`account-erasure/v1/test-v1/${userHash}/`);
  });

  it("lists global intent references without downloading every retained object", async () => {
    const requests: CapturedRequest[] = [];
    const key = `account-erasure/v1/test-v1/${userHash}/${requestId}.json`;
    const client = makeClient(async (request) => {
      requests.push(request);
      return {
        response: {
          body: Readable.from(
            `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>erasure-ledger</Name><Prefix>account-erasure/v1/</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.listIntentReferences()).resolves.toEqual([
      { keyId: "test-v1", requestId, userHash },
    ]);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.query?.["list-type"]).toBe("2");
  });

  it("fails closed when R2 repeats a continuation token", async () => {
    let requests = 0;
    const client = makeClient(async () => {
      requests += 1;
      if (requests > 2) {
        throw new Error("Restore-ledger listing issued an unbounded third request");
      }
      return {
        response: {
          body: Readable.from(
            '<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>erasure-ledger</Name><Prefix>account-erasure/v1/</Prefix><KeyCount>0</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>true</IsTruncated><NextContinuationToken>repeat</NextContinuationToken></ListBucketResult>',
          ),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.listIntentReferences()).rejects.toThrow(
      "Account erasure restore ledger listing repeated a continuation token",
    );
    expect(requests).toBe(2);
  });

  it.each([
    "account-erasure/v1/not-an-intent.json",
    `account-erasure/v1/test-v1/${userHash}/${requestId}.txt`,
    `account-erasure/v1/test-v1/${userHash}/not-a-request-id.json`,
    `account-erasure/v1/test-v1/${userHash}/${requestId}/extra.json`,
  ])("fails closed for malformed managed ledger object %s", async (key) => {
    const client = makeClient(async () => ({
      response: {
        body: Readable.from(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>erasure-ledger</Name><Prefix>account-erasure/v1/</Prefix><KeyCount>1</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
        ),
        headers: { "content-type": "application/xml" },
        statusCode: 200,
      },
    }));
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.listIntentReferences()).rejects.toThrow(
      `Account erasure restore ledger contains malformed object key ${key}`,
    );
  });
});
