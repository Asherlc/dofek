import { z } from "zod";

const maximumDecodedCursorBytes = 2 * 1_024;

const analyticalCursorPayloadSchema = z
  .object({
    version: z.literal(1),
    userId: z.string().uuid(),
    activityId: z.string().uuid(),
    shape: z.string().min(1),
    nextRecordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export interface AnalyticalCursorPayload {
  version: 1;
  userId: string;
  activityId: string;
  shape: string;
  nextRecordedAt: string;
}

type AnalyticalCursorBinding = Pick<AnalyticalCursorPayload, "userId" | "activityId" | "shape">;

export function encodeAnalyticalCursor(payload: AnalyticalCursorPayload): string {
  const parsed = analyticalCursorPayloadSchema.parse(payload);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

export function decodeAnalyticalCursor(
  cursor: string,
  expected: AnalyticalCursorBinding,
): AnalyticalCursorPayload {
  let payload: AnalyticalCursorPayload;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error("Malformed Base64URL");
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (
      Buffer.byteLength(decoded, "utf8") > maximumDecodedCursorBytes ||
      Buffer.from(decoded, "utf8").toString("base64url") !== cursor
    ) {
      throw new Error("Invalid cursor encoding");
    }
    payload = analyticalCursorPayloadSchema.parse(JSON.parse(decoded));
  } catch {
    throw new Error("Invalid analytical cursor");
  }

  if (
    payload.userId !== expected.userId ||
    payload.activityId !== expected.activityId ||
    payload.shape !== expected.shape
  ) {
    throw new Error("Cursor does not match this request");
  }
  return payload;
}
