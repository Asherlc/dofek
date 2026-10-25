import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProviderArtifactStorageTestContext } from "./test-helpers.ts";

const endpoint = "https://r2.fit-retention.test";
const bucket = "imports";
const { client, storage, server, originals, writes } = createProviderArtifactStorageTestContext(
  endpoint,
  bucket,
);
let directory: string;

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => {
  server.close();
  client.destroy();
});
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "fit-retention-network-"));
  originals.clear();
  writes.length = 0;
});
afterEach(async () => {
  server.resetHandlers();
  await rm(directory, { recursive: true, force: true });
});

describe("original FIT retention over S3", () => {
  it("retains byte-exact multichunk originals after source cleanup and reuses retry content", async () => {
    const bytes = Buffer.alloc(256 * 1024);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const filePath = join(directory, "original.fit");
    await writeFile(filePath, bytes);
    const input = { userId: "user-1", providerId: "wahoo", filePath };

    const key = await storage.retainFile(input);
    expect(await storage.retainFile(input)).toBe(key);
    const renamedPath = join(directory, "renamed.fit");
    await writeFile(renamedPath, bytes);
    expect(await storage.retainFile({ ...input, filePath: renamedPath })).toBe(key);
    await rm(filePath);
    await rm(renamedPath);
    const replayPath = join(directory, "replay.fit");
    await storage.materializeArtifact(key, replayPath);

    expect(await readFile(replayPath)).toEqual(bytes);
    expect(writes).toHaveLength(1);
    expect(originals.size).toBe(1);
  });

  it("retains different bytes independently when the same local filename is reused", async () => {
    const filePath = join(directory, "original.fit");
    const input = { userId: "user-1", providerId: "fit-file", filePath };
    await writeFile(filePath, "first malformed FIT");
    const firstKey = await storage.retainFile(input);
    await writeFile(filePath, "second unsupported FIT");
    const secondKey = await storage.retainFile(input);

    expect(firstKey).not.toBe(secondKey);
    expect(originals.get(firstKey)?.toString()).toBe("first malformed FIT");
    expect(originals.get(secondKey)?.toString()).toBe("second unsupported FIT");
    expect(writes).toHaveLength(2);
  });

  it("restores a missing explicit owned object under its original identity", async () => {
    const filePath = join(directory, "garmin.fit");
    const key = `provider-artifacts/user-1/garmin/${"a".repeat(64)}.fit`;
    await writeFile(filePath, "Garmin original");
    await expect(
      storage.retainFile({
        userId: "user-1",
        providerId: "garmin",
        filePath,
        retainedObjectKey: key,
      }),
    ).resolves.toBe(key);
    expect(originals.get(key)?.toString()).toBe("Garmin original");
    expect(originals.size).toBe(1);
  });

  it("propagates a denied archive write and retains the local source for retry", async () => {
    server.use(
      http.put(
        `${endpoint}/${bucket}/*`,
        () =>
          new HttpResponse(
            "<Error><Code>AccessDenied</Code><Message>Archive write denied</Message></Error>",
            { status: 403, headers: { "Content-Type": "application/xml" } },
          ),
      ),
    );
    const filePath = join(directory, "original.fit");
    await writeFile(filePath, "malformed original");
    await expect(
      storage.retainFile({ userId: "user-1", providerId: "fit-file", filePath }),
    ).rejects.toThrow("Archive write denied");
    expect(await readFile(filePath, "utf8")).toBe("malformed original");
    expect(originals.size).toBe(0);
  });

  it("checks exact provider ownership using one bounded S3 list request", async () => {
    const queries: URLSearchParams[] = [];
    const ownedKey = `provider-artifacts/user-1/fit-file/${"b".repeat(64)}.fit`;
    server.use(
      http.get(`${endpoint}/${bucket}/`, ({ request }) => {
        const query = new URL(request.url).searchParams;
        queries.push(query);
        const contents =
          query.get("prefix") === "provider-artifacts/user-1/fit-file/"
            ? `<Contents><Key>${ownedKey}</Key></Contents>`
            : "";
        return new HttpResponse(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
          { headers: { "Content-Type": "application/xml" } },
        );
      }),
    );

    expect(await storage.hasForProvider("user-1", "fit-file")).toBe(true);
    expect(await storage.hasForProvider("user-2", "fit-file")).toBe(false);
    expect(await storage.hasForProvider("user-1", "wahoo")).toBe(false);
    expect(queries).toHaveLength(3);
    expect(
      queries.every((query) => query.get("max-keys") === "1" && query.get("list-type") === "2"),
    ).toBe(true);
  });
});
