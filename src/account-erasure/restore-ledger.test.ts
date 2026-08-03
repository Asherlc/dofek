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
    response: { body?: Readable; headers: Record<string, string>; statusCode: number };
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

  it.each([
    ["requestedAt", { requestedAt: "2026-07-26T13:00:00.000Z" }],
    ["statusToken", { statusToken: "b".repeat(43) }],
  ])("rejects an immutable-intent conflict in %s", async (_field, difference) => {
    const intent = {
      keyId: "test-v1",
      requestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken,
      userHash,
    };
    const conflictingIntent = { ...intent, ...difference };
    const client = makeClient(async (request) => {
      if (request.method === "PUT") {
        throw Object.assign(new Error("precondition failed"), {
          $metadata: { httpStatusCode: 412 },
        });
      }
      return {
        response: {
          body: Readable.from(JSON.stringify(sealAccountErasureRestoreIntent(conflictingIntent))),
          headers: { "content-type": "application/json" },
          statusCode: 200,
        },
      };
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.recordIntent(intent)).rejects.toThrow(
      "conflicts with its immutable ledger entry",
    );
  });

  it("returns null for each supported R2 not-found error shape", async () => {
    const errors: unknown[] = [
      Object.assign(new Error("missing"), { name: "NoSuchKey" }),
      Object.assign(new Error("missing"), { name: "NotFound" }),
      Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } }),
    ];
    const client = makeClient(async () => {
      const error = errors.shift();
      if (!error) throw new Error("missing error fixture");
      throw error;
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.findIntent({ keyId: "test-v1", requestId, userHash })).resolves.toBeNull();
    await expect(ledger.findIntent({ keyId: "test-v1", requestId, userHash })).resolves.toBeNull();
    await expect(ledger.findIntent({ keyId: "test-v1", requestId, userHash })).resolves.toBeNull();
  });

  it("rejects an object without a body and malformed sealed intent JSON", async () => {
    const clientWithoutBody = new S3Client({
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      region: "auto",
    });
    const sendWithoutBody = vi.spyOn(clientWithoutBody, "send");
    Reflect.apply(sendWithoutBody.mockResolvedValueOnce, sendWithoutBody, [{ Body: undefined }]);

    await expect(
      new R2AccountErasureRestoreLedger(clientWithoutBody, "erasure-ledger").findIntent({
        keyId: "test-v1",
        requestId,
        userHash,
      }),
    ).rejects.toThrow("has no body");

    const malformedClient = makeClient(async () => ({
      response: {
        body: Readable.from("not-json"),
        headers: { "content-type": "application/json" },
        statusCode: 200,
      },
    }));
    await expect(
      new R2AccountErasureRestoreLedger(malformedClient, "erasure-ledger").findIntent({
        keyId: "test-v1",
        requestId,
        userHash,
      }),
    ).rejects.toThrow();
  });

  it("rejects an intent whose content does not match its object key", async () => {
    const intent = {
      keyId: "test-v1",
      requestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken,
      userHash: "b".repeat(64),
    };
    const client = makeClient(async () => ({
      response: {
        body: Readable.from(JSON.stringify(sealAccountErasureRestoreIntent(intent))),
        headers: { "content-type": "application/json" },
        statusCode: 200,
      },
    }));
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.findIntent({ keyId: "test-v1", requestId, userHash })).rejects.toThrow(
      "does not match its key",
    );
  });

  it("propagates a failed conditional write that is not a precondition failure", async () => {
    const client = makeClient(async () => {
      throw Object.assign(new Error("bucket unavailable"), {
        $metadata: { httpStatusCode: 503 },
      });
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(
      ledger.recordIntent({
        keyId: "test-v1",
        requestId,
        requestedAt: "2026-07-26T12:00:00.000Z",
        statusToken,
        userHash,
      }),
    ).rejects.toThrow("bucket unavailable");
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

  it("lists multiple ledger pages and rejects a truncated page without a token", async () => {
    let requests = 0;
    const client = makeClient(async () => {
      requests += 1;
      const body =
        requests === 1
          ? '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>page-2</NextContinuationToken><Contents><Key>account-erasure/v1/test-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/10000000-0000-4000-8000-000000001994.json</Key></Contents></ListBucketResult>'
          : '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>account-erasure/v1/test-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/20000000-0000-4000-8000-000000001994.json</Key></Contents></ListBucketResult>';
      return {
        response: {
          body: Readable.from(body),
          headers: { "content-type": "application/xml" },
          statusCode: 200,
        },
      };
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.listIntentReferences()).resolves.toHaveLength(2);
    expect(requests).toBe(2);

    const truncatedClient = makeClient(async () => ({
      response: {
        body: Readable.from(
          '<?xml version="1.0"?><ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>',
        ),
        headers: { "content-type": "application/xml" },
        statusCode: 200,
      },
    }));
    await expect(
      new R2AccountErasureRestoreLedger(truncatedClient, "erasure-ledger").listIntentReferences(),
    ).rejects.toThrow("truncated without a continuation token");
  });

  it.each([
    "unrelated-prefix/account.json",
    "account-erasure/v1/test-v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/10000000-0000-4000-8000-000000001994.txt",
  ])("rejects a listed object with an invalid managed prefix or suffix: %s", async (key) => {
    const client = makeClient(async () => ({
      response: {
        body: Readable.from(
          `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
        ),
        headers: { "content-type": "application/xml" },
        statusCode: 200,
      },
    }));
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.listIntentReferences()).rejects.toThrow("malformed object key");
  });

  it("rejects an identity intent that disappears before it can be downloaded", async () => {
    const key = `account-erasure/v1/test-v1/${userHash}/${requestId}.json`;
    const client = makeClient(async (request) => {
      if (request.method === "GET" && request.query?.prefix) {
        return {
          response: {
            body: Readable.from(
              `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>${key}</Key></Contents></ListBucketResult>`,
            ),
            headers: { "content-type": "application/xml" },
            statusCode: 200,
          },
        };
      }
      throw Object.assign(new Error("missing"), { $metadata: { httpStatusCode: 404 } });
    });
    const ledger = new R2AccountErasureRestoreLedger(client, "erasure-ledger");

    await expect(ledger.listIntentsForIdentities([{ keyId: "test-v1", userHash }])).rejects.toThrow(
      "disappeared during listing",
    );
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
