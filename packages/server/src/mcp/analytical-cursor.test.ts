import { describe, expect, it } from "vitest";
import { decodeAnalyticalCursor, encodeAnalyticalCursor } from "./analytical-cursor.ts";

const userId = "326df19b-bb51-4b5b-9579-0cfddabe172f";
const activityId = "54c63104-47e7-49f9-aac2-8a20ecfc4910";
const shape = "power,heart_rate|5s|none";

function rawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("analytical cursor", () => {
  it("round-trips paging state bound to its user, activity, and request shape", () => {
    const payload = {
      version: 1 as const,
      userId,
      activityId,
      shape,
      nextRecordedAt: "2026-09-01T12:00:05.000Z",
    };

    const cursor = encodeAnalyticalCursor(payload);

    expect(decodeAnalyticalCursor(cursor, { userId, activityId, shape })).toEqual(payload);
  });

  it.each([
    ["user", { userId: "50355baf-54b5-4ef4-a5f0-e7fa8800d3d8", activityId, shape }],
    ["activity", { userId, activityId: "e43ddf95-082d-473d-a591-c84614b26c82", shape }],
    ["shape", { userId, activityId, shape: "power|raw|none" }],
  ])("rejects a cursor reused with a changed %s", (_field, expected) => {
    const cursor = encodeAnalyticalCursor({
      version: 1,
      userId,
      activityId,
      shape,
      nextRecordedAt: "2026-09-01T12:00:05.000Z",
    });

    expect(() => decodeAnalyticalCursor(cursor, expected)).toThrow(
      "Cursor does not match this request",
    );
  });

  it.each([
    ["malformed Base64URL", "%%%"],
    ["invalid JSON", Buffer.from("not JSON").toString("base64url")],
    [
      "unsupported version",
      rawCursor({
        version: 2,
        userId,
        activityId,
        shape,
        nextRecordedAt: "2026-09-01T12:00:05.000Z",
      }),
    ],
    [
      "invalid timestamp",
      rawCursor({ version: 1, userId, activityId, shape, nextRecordedAt: "yesterday" }),
    ],
    [
      "extra fields",
      rawCursor({
        version: 1,
        userId,
        activityId,
        shape,
        nextRecordedAt: "2026-09-01T12:00:05.000Z",
        ignored: true,
      }),
    ],
  ])("rejects %s", (_case, cursor) => {
    expect(() => decodeAnalyticalCursor(cursor, { userId, activityId, shape })).toThrow(
      "Invalid analytical cursor",
    );
  });

  it("rejects decoded cursor payloads larger than two KiB", () => {
    const cursor = rawCursor({
      version: 1,
      userId,
      activityId,
      shape: "x".repeat(2_048),
      nextRecordedAt: "2026-09-01T12:00:05.000Z",
    });

    expect(() =>
      decodeAnalyticalCursor(cursor, { userId, activityId, shape: "x".repeat(2_048) }),
    ).toThrow("Invalid analytical cursor");
  });
});
