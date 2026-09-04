import { readFileSync, renameSync, writeFileSync } from "@zos/fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appendBackgroundHealthEvents, type BackgroundHealthOutbox } from "./background-health.ts";
import {
  parseBackgroundHealthOutbox,
  readBackgroundHealthOutbox,
  readBackgroundHealthOutboxForCollection,
  serializeBackgroundHealthOutbox,
  writeBackgroundHealthOutbox,
} from "./background-health-storage.ts";
import { createEmptyOutbox } from "./durable-outbox.ts";

vi.mock("@zos/fs", () => ({
  readFileSync: vi.fn(),
  renameSync: vi.fn(() => 0),
  writeFileSync: vi.fn(),
}));

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
const canonicalSampleEntry = {
  eventId: "sample-1",
  createdAt: sample.recordedAt,
  attempts: 0,
  payload: { kind: "sample", sample },
};

function canonicalOutbox(
  pending: unknown[] = [canonicalSampleEntry],
  quarantine: unknown[] = [],
): string {
  return JSON.stringify({ version: 1, pending, quarantine });
}

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

  it.each([
    null,
    [],
    "invalid",
    { ...canonicalSampleEntry, eventId: 1 },
    { ...canonicalSampleEntry, eventId: " " },
    { ...canonicalSampleEntry, createdAt: 1 },
    { ...canonicalSampleEntry, attempts: 1.5 },
    { ...canonicalSampleEntry, attempts: -1 },
    { ...canonicalSampleEntry, lastError: 1 },
  ])("rejects invalid canonical entries %#", (entry) => {
    expect(() => parseBackgroundHealthOutbox(canonicalOutbox([entry]), installId)).toThrow();
  });

  it.each([
    null,
    [],
    { kind: "unknown" },
    { kind: "sample", sample: null },
    { kind: "activity", activity: null },
    { kind: "summary", summary: null },
  ])("rejects invalid pending event payloads %#", (payload) => {
    expect(() =>
      parseBackgroundHealthOutbox(
        canonicalOutbox([{ ...canonicalSampleEntry, payload }]),
        installId,
      ),
    ).toThrow();
  });

  it("parses retained errors and quarantined issues exactly", () => {
    const pendingEntry = { ...canonicalSampleEntry, lastError: "offline" };
    const quarantinedEntry = {
      ...canonicalSampleEntry,
      eventId: "quarantined-1",
      issues: [{ path: "sample.heartRate", message: "Expected number" }],
    };

    expect(
      parseBackgroundHealthOutbox(canonicalOutbox([pendingEntry], [quarantinedEntry]), installId),
    ).toStrictEqual({
      pending: [pendingEntry],
      quarantine: [quarantinedEntry],
    });
  });

  it.each([
    null,
    { ...canonicalSampleEntry, issues: {} },
    { ...canonicalSampleEntry, issues: [null] },
    { ...canonicalSampleEntry, issues: [{ path: 1, message: "bad" }] },
    { ...canonicalSampleEntry, issues: [{ path: "sample", message: 1 }] },
  ])("rejects invalid quarantine entries %#", (entry) => {
    expect(() => parseBackgroundHealthOutbox(canonicalOutbox([], [entry]), installId)).toThrow();
  });

  it.each([
    "null",
    "[]",
    JSON.stringify({ version: 2, pending: [], quarantine: [] }),
    JSON.stringify({ version: 1, pending: {}, quarantine: [] }),
    JSON.stringify({ version: 1, pending: [], quarantine: {} }),
    JSON.stringify({ samples: {}, activities: [] }),
    JSON.stringify({ samples: [], activities: {} }),
  ])("rejects invalid outbox shapes %#", (serialized) => {
    expect(() => parseBackgroundHealthOutbox(serialized, installId)).toThrow(
      "Background health outbox has an invalid shape.",
    );
  });

  it("drops non-finite optional legacy readings instead of retaining corrupt values", () => {
    const parsed = parseBackgroundHealthOutbox(
      JSON.stringify({
        samples: [
          {
            recordedAt: sample.recordedAt,
            heartRate: "72",
            bloodOxygenPercent: Number.NaN,
            bodyTemperatureCelsius: null,
            stress: Number.POSITIVE_INFINITY,
          },
        ],
        activities: [],
      }),
      installId,
    );

    expect(parsed.pending[0]?.payload).toStrictEqual({
      kind: "sample",
      sample: {
        recordedAt: sample.recordedAt,
        heartRate: undefined,
        bloodOxygenPercent: undefined,
        bodyTemperatureCelsius: undefined,
        stress: undefined,
      },
    });
  });

  it("bounds legacy samples to seven days", () => {
    const samples = Array.from({ length: 10_082 }, (_, index) => ({
      recordedAt: new Date(index * 60_000).toISOString(),
    }));

    const parsed = parseBackgroundHealthOutbox(
      JSON.stringify({ samples, activities: [] }),
      installId,
    );

    expect(parsed.pending).toHaveLength(10_080);
    expect(parsed.pending[0]?.createdAt).toBe(samples[2]?.recordedAt);
    expect(parsed.pending.at(-1)?.createdAt).toBe(samples.at(-1)?.recordedAt);
  });

  it("deduplicates legacy samples by stable event ID", () => {
    const parsed = parseBackgroundHealthOutbox(
      JSON.stringify({ samples: [sample, sample], activities: [] }),
      installId,
    );

    expect(parsed.pending).toHaveLength(1);
    expect(parsed.pending[0]?.payload).toEqual({ kind: "sample", sample });
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
      "Background health outbox storage is corrupt.",
    );

    vi.mocked(readFileSync).mockReturnValueOnce(new ArrayBuffer(1));
    expect(() => readBackgroundHealthOutbox(installId)).toThrow(
      "Background health outbox storage returned non-text data.",
    );
  });

  it("recovers corrupt persisted data for the next collection and reports the discard", () => {
    const onDiscard = vi.fn();
    vi.mocked(readFileSync).mockReturnValueOnce("not-json");

    expect(readBackgroundHealthOutboxForCollection(installId, onDiscard)).toEqual({
      pending: [],
      quarantine: [],
    });
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(renameSync).toHaveBeenCalledWith({
      oldPath: "data://health/background.json",
      newPath: "data://health/background.json.corrupt",
    });
  });

  it("fails loudly when corrupt storage cannot be quarantined", () => {
    vi.mocked(readFileSync).mockReturnValueOnce("not-json");
    vi.mocked(renameSync).mockReturnValueOnce(-1);
    const onDiscard = vi.fn();

    expect(() => readBackgroundHealthOutboxForCollection(installId, onDiscard)).toThrow(
      "Could not quarantine corrupt background health data (-1).",
    );
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it("does not leak unknown summary fields through parsing", () => {
    const serialized = JSON.stringify({
      version: 1,
      pending: [
        {
          eventId: "summary-1",
          createdAt: "2024-07-03T10:48:20.000Z",
          attempts: 0,
          payload: {
            kind: "summary",
            summary: {
              collectedAt: 1_720_003_700_000,
              date: "2024-07-03",
              timezoneOffsetMinutes: 0,
              privateValue: "must-not-survive",
            },
          },
        },
      ],
      quarantine: [],
    });

    expect(parseBackgroundHealthOutbox(serialized, installId).pending[0]?.payload).toEqual({
      kind: "summary",
      summary: {
        collectedAt: 1_720_003_700_000,
        date: "2024-07-03",
        timezoneOffsetMinutes: 0,
      },
    });
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
