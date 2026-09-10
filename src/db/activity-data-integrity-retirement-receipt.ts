import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";

const receiptChecksumSchema = z.string().regex(/^[0-9a-f]{64}$/);

const retirementReceiptDecisionSchema = z.object({
  schemaVersion: z.number().int().positive(),
  runId: z.string().uuid(),
  artifactPath: z.string().min(1),
  acceptedBy: z.string().min(1),
  disposition: z.enum(["accepted", "superseded"]),
  retiredAt: z.string().datetime(),
  rollbackEligibility: z.literal("retired"),
});

const retirementReceiptSchema = retirementReceiptDecisionSchema.extend({
  receiptChecksum: receiptChecksumSchema,
});

type RetirementReceiptDecision = z.infer<typeof retirementReceiptDecisionSchema>;
export type ActivityIntegrityRetirementReceipt = z.infer<typeof retirementReceiptSchema>;

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function checksumReceipt(receipt: RetirementReceiptDecision): string {
  return createHash("sha256").update(serializeJson(receipt)).digest("hex");
}

export function activityIntegrityRetirementReceiptPath(artifactPath: string): string {
  return `${artifactPath}.retired.json`;
}

export function makeActivityIntegrityRetirementReceipt(input: {
  schemaVersion: number;
  runId: string;
  artifactPath: string;
  acceptedBy: string;
  disposition: "accepted" | "superseded";
  retiredAt: Date;
}): ActivityIntegrityRetirementReceipt {
  const decision: RetirementReceiptDecision = {
    schemaVersion: input.schemaVersion,
    runId: input.runId,
    artifactPath: resolve(input.artifactPath),
    acceptedBy: input.acceptedBy,
    disposition: input.disposition,
    retiredAt: input.retiredAt.toISOString(),
    rollbackEligibility: "retired",
  };
  return { ...decision, receiptChecksum: checksumReceipt(decision) };
}

function errorCode(error: unknown): string | undefined {
  if (error == null || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

async function writeNewPrivateJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, serializeJson(value), { encoding: "utf8", flag: "wx", mode: 0o600 });
}

export async function materializeActivityIntegrityRetirementReceipt(
  receiptPath: string,
  receipt: ActivityIntegrityRetirementReceipt,
): Promise<void> {
  try {
    await writeNewPrivateJson(receiptPath, receipt);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    const existing = retirementReceiptSchema.parse(JSON.parse(await readFile(receiptPath, "utf8")));
    if (
      existing.receiptChecksum !== receipt.receiptChecksum ||
      checksumReceipt(retirementReceiptDecisionSchema.parse(existing)) !== existing.receiptChecksum
    ) {
      throw new Error("retirement receipt conflicts with durable journal decision");
    }
  }
}
