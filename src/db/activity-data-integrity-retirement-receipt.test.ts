import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeActivityIntegrityRetirementReceipt,
  materializeActivityIntegrityRetirementReceipt,
} from "./activity-data-integrity-retirement-receipt.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("materializeActivityIntegrityRetirementReceipt", () => {
  it("accepts an idempotent retry of the same durable decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "activity-retirement-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "receipt.json");
    const receipt = makeActivityIntegrityRetirementReceipt({
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      artifactPath: join(directory, "artifact.json"),
      acceptedBy: "data-on-call@example.com",
      disposition: "accepted",
      retiredAt: new Date("2026-09-02T18:00:00.000Z"),
    });

    await materializeActivityIntegrityRetirementReceipt(receiptPath, receipt);
    await expect(
      materializeActivityIntegrityRetirementReceipt(receiptPath, receipt),
    ).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(receiptPath, "utf8"))).toEqual(receipt);
    expect((await stat(receiptPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects a different valid durable decision at the same path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "activity-retirement-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "receipt.json");
    const receipt = makeActivityIntegrityRetirementReceipt({
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      artifactPath: join(directory, "artifact.json"),
      acceptedBy: "data-on-call@example.com",
      disposition: "accepted",
      retiredAt: new Date("2026-09-02T18:00:00.000Z"),
    });
    const conflictingReceipt = makeActivityIntegrityRetirementReceipt({
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      artifactPath: join(directory, "artifact.json"),
      acceptedBy: "another-owner@example.com",
      disposition: "accepted",
      retiredAt: new Date("2026-09-02T18:00:00.000Z"),
    });

    await materializeActivityIntegrityRetirementReceipt(receiptPath, receipt);

    await expect(
      materializeActivityIntegrityRetirementReceipt(receiptPath, conflictingReceipt),
    ).rejects.toThrow("retirement receipt conflicts with durable journal decision");
  });

  it("rejects a stored decision whose checksum was copied from another decision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "activity-retirement-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "receipt.json");
    const receipt = makeActivityIntegrityRetirementReceipt({
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      artifactPath: join(directory, "artifact.json"),
      acceptedBy: "data-on-call@example.com",
      disposition: "accepted",
      retiredAt: new Date("2026-09-02T18:00:00.000Z"),
    });
    await writeFile(
      receiptPath,
      `${JSON.stringify({ ...receipt, acceptedBy: "tampered@example.com" }, null, 2)}\n`,
    );

    await expect(
      materializeActivityIntegrityRetirementReceipt(receiptPath, receipt),
    ).rejects.toThrow("retirement receipt conflicts with durable journal decision");
  });

  it("rejects a requested decision whose checksum does not identify its fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "activity-retirement-receipt-"));
    temporaryDirectories.push(directory);
    const receiptPath = join(directory, "receipt.json");
    const receipt = makeActivityIntegrityRetirementReceipt({
      schemaVersion: 1,
      runId: "00000000-0000-4000-8000-000000000001",
      artifactPath: join(directory, "artifact.json"),
      acceptedBy: "data-on-call@example.com",
      disposition: "accepted",
      retiredAt: new Date("2026-09-02T18:00:00.000Z"),
    });

    await materializeActivityIntegrityRetirementReceipt(receiptPath, receipt);

    await expect(
      materializeActivityIntegrityRetirementReceipt(receiptPath, {
        ...receipt,
        receiptChecksum: "0".repeat(64),
      }),
    ).rejects.toThrow("retirement receipt conflicts with durable journal decision");
  });
});
