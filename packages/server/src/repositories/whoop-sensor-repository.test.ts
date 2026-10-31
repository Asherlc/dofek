import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ActivitySensorQueryStore } from "./activity-sensor-types.ts";
import { WhoopSensorRepository } from "./whoop-sensor-repository.ts";

function storeWithResponses(responses: unknown[][]): ActivitySensorQueryStore {
  return {
    query: vi.fn(async <TSchema extends z.ZodType>(schema: TSchema) =>
      z.array(schema).parse(responses.shift()),
    ),
  };
}

// SQL isolation, date filtering and priority behavior run in the real-engine suite.
describe("WhoopSensorRepository snapshot presentation", () => {
  it("distinguishes no uploaded records from a decoded measurement", async () => {
    const repository = new WhoopSensorRepository(storeWithResponses([[], []]), "user-a");
    expect(await repository.snapshot()).toEqual({
      latestReceivedAt: null,
      latestMeasuredAt: null,
      skinTemperatureC: null,
      records: [],
    });
  });

  it("uses the independent latest thermal reading while retaining original frame provenance", async () => {
    const frameHex = readFileSync(
      new URL(
        "../../../mobile/modules/whoop-ble/Tests/fixtures/imu-activation-capture.tsv",
        import.meta.url,
      ),
      "utf8",
    )
      .split("\n")
      .map((line) => line.split("\t").at(-1) ?? "")
      .find((hex) => hex.length === 248 && hex.slice(16, 20) === "2f12");
    const record = {
      captureId: "1087b7ac-fc32-4c29-8b31-72e366dc974d",
      timestamp: "2026-10-30T12:00:00.000Z",
      frameHex,
      deviceInfo: { name: "WHOOP MG", firmware: "observed-version" },
    };
    const repository = new WhoopSensorRepository(
      storeWithResponses([
        [{ deviceId: "strap-a", metadata: JSON.stringify(record) }],
        [{ skinTemperatureC: 32.2, measuredAt: "2026-03-30T12:00:00.000Z" }],
      ]),
      "user-a",
    );
    const snapshot = await repository.snapshot();
    expect(snapshot).toMatchObject({
      latestReceivedAt: record.timestamp,
      latestMeasuredAt: "2026-03-30T12:00:00.000Z",
      skinTemperatureC: 32.2,
      records: [
        {
          captureId: record.captureId,
          deviceId: "strap-a",
          deviceInfo: record.deviceInfo,
          receivedAt: record.timestamp,
          rawFrameHex: frameHex,
          skinTemperatureC: 32.18,
          measuredAt: "2026-03-29T15:28:11.430Z",
        },
      ],
    });
  });
});
