import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: (...arguments_: unknown[]) => mockSpawn(...arguments_),
}));

import { FitDecoderError, streamFitFile } from "./stream-decoder.ts";

interface SimulatedDecoder {
  acknowledgements: string[];
  child: EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  finish: (code?: number) => void;
  send: (message: unknown) => void;
  waitForAcknowledgement: (count: number) => Promise<void>;
}

function simulatedDecoder(): SimulatedDecoder {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const acknowledgementEvents = new EventEmitter();
  const acknowledgements: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      acknowledgements.push(chunk.toString());
      acknowledgementEvents.emit("acknowledgement");
      callback();
    },
  });
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    kill: vi.fn(() => {
      stdout.end();
      queueMicrotask(() => child.emit("exit", null, "SIGKILL"));
      return true;
    }),
  });
  return {
    acknowledgements,
    child,
    finish: (code = 0) => {
      stdout.end();
      queueMicrotask(() => child.emit("exit", code, null));
    },
    send: (message) => stdout.write(`${JSON.stringify(message)}\n`),
    waitForAcknowledgement: async (count) => {
      while (acknowledgements.length < count) {
        await new Promise<void>((resolvePromise) => {
          acknowledgementEvents.once("acknowledgement", resolvePromise);
        });
      }
    },
  };
}

describe("streamFitFile", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockSpawn.mockReset();
  });

  it("uses Garmin profile names and acknowledges a batch only after it is consumed", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    let releaseRecordBatch: (() => void) | undefined;
    const recordBatchStarted = new Promise<void>((resolvePromise) => {
      releaseRecordBatch = resolvePromise;
    });
    const recordBatchConsumed = new Promise<void>((resolvePromise) => {
      queueMicrotask(async () => {
        decoder.send({
          type: "metadata",
          fileType: 4,
          hasWeightMessages: false,
          session: {
            sport: 2,
            sub_sport: 8,
            start_time: "2026-07-01T12:00:00.000Z",
            total_elapsed_time: 60,
          },
          sportName: "cycling",
          subSportName: "mountain",
        });
        await decoder.waitForAcknowledgement(1);
        decoder.send({
          type: "records",
          messages: [{ timestamp: "2026-07-01T12:00:01.000Z", power: 250 }],
        });
        await decoder.waitForAcknowledgement(2);
        decoder.send({ type: "end", messageCount: 1 });
        decoder.finish();
        resolvePromise();
      });
    });

    let continueRecordBatch: (() => void) | undefined;
    const holdRecordBatch = new Promise<void>((resolvePromise) => {
      continueRecordBatch = resolvePromise;
    });
    const streamPromise = streamFitFile("activity.fit", {
      onMetadata: async (metadata) => {
        expect(metadata.session).toEqual(
          expect.objectContaining({ sport: "cycling", subSport: "mountain" }),
        );
      },
      onRecordBatch: async (records) => {
        expect(records).toEqual([
          expect.objectContaining({
            recordedAt: new Date("2026-07-01T12:00:01.000Z"),
            power: 250,
          }),
        ]);
        releaseRecordBatch?.();
        await holdRecordBatch;
      },
      onWeightBatch: async () => undefined,
    });

    await recordBatchStarted;
    expect(decoder.acknowledgements).toEqual(["continue\n"]);
    continueRecordBatch?.();

    await expect(streamPromise).resolves.toEqual({ messageCount: 1 });
    await recordBatchConsumed;
    expect(decoder.acknowledgements).toEqual(["continue\n", "continue\n"]);
  });

  it("reports a native decoder failure as a FIT decoder error", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send({
        type: "metadata",
        fileType: null,
        hasWeightMessages: false,
        session: null,
        sportName: null,
        subSportName: null,
      });
      await decoder.waitForAcknowledgement(1);
      decoder.child.stderr.write("FIT decode failed: invalid header\n");
      decoder.finish(1);
    });

    const streamPromise = streamFitFile("broken.fit", {
      onMetadata: async () => undefined,
      onRecordBatch: async () => undefined,
      onWeightBatch: async () => undefined,
    });

    await expect(streamPromise).rejects.toBeInstanceOf(FitDecoderError);
    await expect(streamPromise).rejects.toThrow(
      "Native FIT decoder failed: FIT decode failed: invalid header",
    );
  });

  it("rejects record batches before metadata without calling the consumer", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onRecordBatch = vi.fn(async () => undefined);
    queueMicrotask(() => {
      decoder.send({
        type: "records",
        messages: [{ timestamp: "2026-07-01T12:00:01.000Z", power: 250 }],
      });
      decoder.finish();
    });

    const streamPromise = streamFitFile("activity.fit", {
      onMetadata: async () => undefined,
      onRecordBatch,
      onWeightBatch: async () => undefined,
    });

    await expect(streamPromise).rejects.toThrow(
      "Native FIT decoder returned records before activity metadata",
    );
    expect(onRecordBatch).not.toHaveBeenCalled();
  });

  it("rejects record batches for a weight file", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onRecordBatch = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send({
        type: "metadata",
        fileType: 9,
        hasWeightMessages: true,
        session: null,
        sportName: null,
        subSportName: null,
      });
      await decoder.waitForAcknowledgement(1);
      decoder.send({
        type: "records",
        messages: [{ timestamp: "2026-07-01T12:00:01.000Z", power: 250 }],
      });
      decoder.finish();
    });

    const streamPromise = streamFitFile("weight.fit", {
      onMetadata: async () => undefined,
      onRecordBatch,
      onWeightBatch: async () => undefined,
    });

    await expect(streamPromise).rejects.toThrow(
      "Native FIT decoder returned records for a weight file",
    );
    expect(onRecordBatch).not.toHaveBeenCalled();
  });

  it("times out if the decoder does not exit after its end message", async () => {
    vi.useFakeTimers();
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);

    const streamPromise = streamFitFile("activity.fit", {
      onMetadata: async () => undefined,
      onRecordBatch: async () => undefined,
      onWeightBatch: async () => undefined,
    });
    decoder.send({
      type: "metadata",
      fileType: 4,
      hasWeightMessages: false,
      session: null,
      sportName: null,
      subSportName: null,
    });
    await decoder.waitForAcknowledgement(1);
    decoder.send({ type: "end", messageCount: 0 });
    await vi.advanceTimersByTimeAsync(0);

    const rejectionExpectation = expect(streamPromise).rejects.toThrow(
      "Native FIT decoder was idle for 120000ms",
    );
    await vi.advanceTimersByTimeAsync(120_000);

    if (decoder.child.kill.mock.calls.length === 0) {
      decoder.finish();
    }
    expect(decoder.child.kill).toHaveBeenCalledWith("SIGKILL");
    await rejectionExpectation;
  });
});
