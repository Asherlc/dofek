import { readFileSync, writeFileSync } from "@zos/fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendBackgroundHealthEvents, type BackgroundHealthOutbox } from "./background-health.ts";
import {
  parseBackgroundHealthOutbox,
  readBackgroundHealthOutbox,
  serializeBackgroundHealthOutbox,
  writeBackgroundHealthOutbox,
} from "./background-health-storage.ts";
import { createEmptyOutbox } from "./durable-outbox.ts";

vi.mock("@zos/fs", () => ({ readFileSync: vi.fn(), writeFileSync: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

const installId = "install-1";
const sample = {
  recordedAt: "2024-07-03T10:48:20.000Z",
  heartRate: 72,
  bloodOxygenPercent: 98,
  bodyTemperatureCelsius: 36.6,
  stress: 35,
};
const activity = {
  externalId: "1720000000",
  activityType: "other" as const,
  startedAt: "2024-07-03T09:46:40.000Z",
  endedAt: "2024-07-03T10:46:40.000Z",
};

function populatedOutbox(): BackgroundHealthOutbox {
  return appendBackgroundHealthEvents(
    createEmptyOutbox(),
    { sample, activities: [activity] },
    installId,
  );
}

describe("background health outbox storage", () => {
  it("serializes and parses the canonical versioned outbox", () => {
    const outbox = populatedOutbox();

    expect(parseBackgroundHealthOutbox(serializeBackgroundHealthOutbox(outbox), installId)).toEqual(
      outbox,
    );
  });

  it("migrates the former samples-and-activities buffer deterministically", () => {
    expect(
      parseBackgroundHealthOutbox(
        JSON.stringify({ samples: [sample], activities: [activity] }),
        installId,
      ),
    ).toEqual(populatedOutbox());
  });

  it("rejects corrupt data instead of silently replacing it", () => {
    expect(() => parseBackgroundHealthOutbox("not-json", installId)).toThrow(
      "Background health outbox is not valid JSON.",
    );
    expect(() =>
      parseBackgroundHealthOutbox('{"version":1,"pending":"invalid"}', installId),
    ).toThrow("Background health outbox has an invalid shape.");
    expect(() =>
      parseBackgroundHealthOutbox(
        JSON.stringify({ samples: [{ recordedAt: 123 }], activities: [] }),
        installId,
      ),
    ).toThrow("Background health sample is invalid.");
  });

  it("reads missing storage as empty but surfaces stored corruption", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(readBackgroundHealthOutbox(installId)).toEqual({ pending: [], quarantine: [] });

    const readError = new Error("storage unavailable");
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw readError;
    });
    expect(() => readBackgroundHealthOutbox(installId)).toThrow(readError);

    vi.mocked(readFileSync).mockReturnValueOnce("not-json");
    expect(() => readBackgroundHealthOutbox(installId)).toThrow(
      "Background health outbox is not valid JSON.",
    );
  });

  it("writes only the canonical versioned representation", () => {
    const outbox = populatedOutbox();
    writeBackgroundHealthOutbox(outbox);

    expect(writeFileSync).toHaveBeenCalledWith({
      path: "data://health/background.json",
      data: serializeBackgroundHealthOutbox(outbox),
    });
  });
});
