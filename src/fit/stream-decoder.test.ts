import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockSpawn = vi.hoisted(() => vi.fn());
const mockExistsSync = vi.hoisted(() => vi.fn((_path: string) => false));

vi.mock("node:child_process", () => ({
  spawn: (...arguments_: unknown[]) => mockSpawn(...arguments_),
}));
vi.mock("node:fs", () => ({ existsSync: (path: string) => mockExistsSync(path) }));

import { FitDecoderError, type FitStreamConsumer, streamFitFile } from "./stream-decoder.ts";

interface SimulatedDecoder {
  acknowledgements: string[];
  child: EventEmitter & {
    stdin: Writable;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: CallableVitestMock;
  };
  finish: (code?: number) => void;
  send: (message: unknown) => void;
  sendLine: (line: string) => void;
  waitForAcknowledgement: (count: number) => Promise<void>;
}

function simulatedDecoder(acknowledgementError?: Error): SimulatedDecoder {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const acknowledgementEvents = new EventEmitter();
  const acknowledgements: string[] = [];
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      acknowledgements.push(chunk.toString());
      acknowledgementEvents.emit("acknowledgement");
      callback(acknowledgementError);
    },
  });
  stdin.on("error", () => undefined);
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
    sendLine: (line) => stdout.write(`${line}\n`),
    waitForAcknowledgement: async (count) => {
      while (acknowledgements.length < count) {
        await new Promise<void>((resolvePromise) => {
          acknowledgementEvents.once("acknowledgement", resolvePromise);
        });
      }
    },
  };
}

function metadataMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "metadata",
    fileType: 4,
    fileTypeName: "activity",
    hasWeightMessages: false,
    session: null,
    sportName: null,
    subSportName: null,
    fieldOccurrences: [],
    ...overrides,
  };
}

function noopConsumer(overrides: Partial<FitStreamConsumer> = {}): FitStreamConsumer {
  return {
    onMetadata: async () => undefined,
    onRecordBatch: async () => undefined,
    onWeightBatch: async () => undefined,
    ...overrides,
  };
}

describe("streamFitFile", () => {
  beforeEach(() => {
    vi.useRealTimers();
    mockSpawn.mockReset();
    mockExistsSync.mockReset();
    mockExistsSync.mockReturnValue(false);
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
          fileTypeName: "activity",
          hasWeightMessages: false,
          session: {
            sport: 2,
            sub_sport: 8,
            start_time: "2026-07-01T12:00:00.000Z",
            total_elapsed_time: 60,
          },
          sportName: "cycling",
          subSportName: "mountain",
          fieldOccurrences: [{ messageType: "file_id", field: "time_created", occurrences: 1 }],
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
        expect(metadata.fieldOccurrences).toEqual([
          { messageType: "file_id", field: "time_created", occurrences: 1 },
        ]);
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
    expect(mockSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/\.build\/fit-decoder\/bin\/dofek-fit-decoder$/),
      ["activity.fit"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
  });

  it("uses the installed decoder binary when it is available", async () => {
    mockExistsSync.mockReturnValue(true);
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "end", messageCount: 0 });
      decoder.finish();
    });

    await expect(streamFitFile("activity.fit", noopConsumer())).resolves.toEqual({
      messageCount: 0,
    });
    expect(mockSpawn).toHaveBeenCalledWith("/usr/local/bin/dofek-fit-decoder", ["activity.fit"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("falls back to numeric Garmin enum names and preserves string enums", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onMetadata = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send(
        metadataMessage({
          session: {
            sport: "running",
            sub_sport: 99,
            start_time: "2026-07-01T12:00:00.000Z",
          },
        }),
      );
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "end", messageCount: 0 });
      decoder.finish();
    });

    await streamFitFile("activity.fit", noopConsumer({ onMetadata }));

    expect(onMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sport: "running", subSport: "unknown_99" }),
      }),
    );
  });

  it("uses unknown enum names when neither the raw value nor profile name is usable", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onMetadata = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send(
        metadataMessage({
          session: {
            sport: { invalid: true },
            sub_sport: false,
            start_time: "2026-07-01T12:00:00.000Z",
          },
        }),
      );
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "end", messageCount: 0 });
      decoder.finish();
    });

    await streamFitFile("activity.fit", noopConsumer({ onMetadata }));

    expect(onMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        session: expect.objectContaining({ sport: "unknown", subSport: undefined }),
      }),
    );
  });

  it("streams weight batches and omits non-finite optional values", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onMetadata = vi.fn(async () => undefined);
    const onWeightBatch = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send(metadataMessage({ hasWeightMessages: true }));
      await decoder.waitForAcknowledgement(1);
      decoder.send({
        type: "weights",
        messages: [
          {
            timestamp: "2026-07-01T12:00:00.000Z",
            weight: 80.5,
            percent_fat: "invalid",
            percent_hydration: Number.POSITIVE_INFINITY,
            bone_mass: 3.1,
            muscle_mass: 42.5,
            bmi: 22.2,
          },
        ],
      });
      await decoder.waitForAcknowledgement(2);
      decoder.send({ type: "end", messageCount: 1 });
      decoder.finish();
    });

    await expect(
      streamFitFile("weight.fit", noopConsumer({ onMetadata, onWeightBatch })),
    ).resolves.toEqual({ messageCount: 1 });

    expect(onMetadata).toHaveBeenCalledWith(expect.objectContaining({ isWeightFile: true }));
    expect(onWeightBatch).toHaveBeenCalledWith([
      expect.objectContaining({
        timestamp: new Date("2026-07-01T12:00:00.000Z"),
        weight: 80.5,
        percentFat: undefined,
        percentHydration: undefined,
        boneMass: 3.1,
        muscleMass: 42.5,
        bmi: 22.2,
      }),
    ]);
    expect(decoder.acknowledgements).toEqual(["continue\n", "continue\n"]);
  });

  it("reports a native decoder failure as a FIT decoder error", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send({
        type: "metadata",
        fileType: null,
        fileTypeName: null,
        hasWeightMessages: false,
        session: null,
        sportName: null,
        subSportName: null,
        fieldOccurrences: [],
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

    const caughtError: unknown = await streamPromise.catch((error: unknown) => error);
    expect(caughtError).toBeInstanceOf(FitDecoderError);
    if (!(caughtError instanceof FitDecoderError)) {
      throw new Error("Expected FIT decoder error");
    }
    expect(caughtError.message).toBe(
      "Native FIT decoder failed: FIT decode failed: invalid header",
    );
  });

  it("reports the exit code when the decoder fails without stderr", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.finish(2);
    });

    await expect(streamFitFile("broken.fit", noopConsumer())).rejects.toThrow(
      "Native FIT decoder failed: terminated by exit code 2",
    );
  });

  it("bounds stderr retained from a failed decoder", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.child.stderr.write(Buffer.alloc(70 * 1024, "x"));
      decoder.child.stderr.write("discarded");
      decoder.finish(1);
    });

    const caughtError: unknown = await streamFitFile("broken.fit", noopConsumer()).catch(
      (error: unknown) => error,
    );

    expect(caughtError).toBeInstanceOf(FitDecoderError);
    if (!(caughtError instanceof Error)) {
      throw new Error("Expected FIT decoder error");
    }
    expect(caughtError.message).toHaveLength("Native FIT decoder failed: ".length + 64 * 1024);
    expect(caughtError.message.endsWith("discarded")).toBe(false);
  });

  it("rejects invalid decoder JSON", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(() => decoder.sendLine("{invalid-json"));

    const caughtError: unknown = await streamFitFile("broken.fit", noopConsumer()).catch(
      (error: unknown) => error,
    );
    expect(caughtError).toBeInstanceOf(FitDecoderError);
    if (!(caughtError instanceof FitDecoderError)) {
      throw new Error("Expected FIT decoder error");
    }
    expect(caughtError.message).toBe("Native FIT decoder returned invalid JSON");
    expect(caughtError.cause).toBeInstanceOf(SyntaxError);
    expect(decoder.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("rejects decoder messages outside the protocol schema", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(() => decoder.send({ type: "unexpected" }));

    const caughtError: unknown = await streamFitFile("broken.fit", noopConsumer()).catch(
      (error: unknown) => error,
    );
    expect(caughtError).toBeInstanceOf(FitDecoderError);
    if (!(caughtError instanceof FitDecoderError)) {
      throw new Error("Expected FIT decoder error");
    }
    expect(caughtError.message).toBe("Native FIT decoder returned an invalid protocol message");
    expect(caughtError.cause).toBeInstanceOf(Error);
  });

  it("reports decoder process startup failures", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(() => {
      decoder.child.emit("error", new Error("permission denied"));
      decoder.child.stdout.end();
    });

    const caughtError: unknown = await streamFitFile("activity.fit", noopConsumer()).catch(
      (error: unknown) => error,
    );
    expect(caughtError).toBeInstanceOf(FitDecoderError);
    if (!(caughtError instanceof FitDecoderError)) {
      throw new Error("Expected FIT decoder error");
    }
    expect(caughtError.message).toBe("Unable to start the native FIT decoder");
    expect(caughtError.cause).toEqual(new Error("permission denied"));
    expect(decoder.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("reports acknowledgement write failures", async () => {
    const decoder = simulatedDecoder(new Error("broken pipe"));
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(() => decoder.send(metadataMessage()));

    const caughtError: unknown = await streamFitFile("activity.fit", noopConsumer()).catch(
      (error: unknown) => error,
    );
    expect(caughtError).toBeInstanceOf(FitDecoderError);
    if (!(caughtError instanceof FitDecoderError)) {
      throw new Error("Expected FIT decoder error");
    }
    expect(caughtError.message).toBe("Unable to acknowledge the native FIT decoder");
    expect(caughtError.cause).toEqual(new Error("broken pipe"));
  });

  it("kills the decoder when a consumer rejects metadata", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(() => decoder.send(metadataMessage()));

    await expect(
      streamFitFile(
        "activity.fit",
        noopConsumer({
          onMetadata: async () => {
            throw new Error("consumer failed");
          },
        }),
      ),
    ).rejects.toThrow("consumer failed");
    expect(decoder.child.kill).toHaveBeenCalledWith("SIGKILL");
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

  it("rejects records with invalid timestamps", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onRecordBatch = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "records", messages: [{ timestamp: "not-a-date" }] });
    });

    await expect(streamFitFile("activity.fit", noopConsumer({ onRecordBatch }))).rejects.toThrow(
      "FIT record message is missing a valid timestamp",
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
        fileTypeName: "weight",
        hasWeightMessages: true,
        session: null,
        sportName: null,
        subSportName: null,
        fieldOccurrences: [],
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

  it("rejects weight batches before metadata", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onWeightBatch = vi.fn(async () => undefined);
    queueMicrotask(() => {
      decoder.send({
        type: "weights",
        messages: [{ timestamp: "2026-07-01T12:00:00.000Z", weight: 80 }],
      });
    });

    await expect(streamFitFile("weight.fit", noopConsumer({ onWeightBatch }))).rejects.toThrow(
      "Native FIT decoder returned weights before file metadata",
    );
    expect(onWeightBatch).not.toHaveBeenCalled();
  });

  it("rejects weight batches for activity files", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onWeightBatch = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.send({
        type: "weights",
        messages: [{ timestamp: "2026-07-01T12:00:00.000Z", weight: 80 }],
      });
    });

    await expect(streamFitFile("activity.fit", noopConsumer({ onWeightBatch }))).rejects.toThrow(
      "Native FIT decoder returned weights for an activity file",
    );
    expect(onWeightBatch).not.toHaveBeenCalled();
  });

  it("rejects weights with invalid timestamps", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onWeightBatch = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send(metadataMessage({ fileType: 9, fileTypeName: "weight" }));
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "weights", messages: [{ timestamp: "not-a-date", weight: 80 }] });
    });

    await expect(streamFitFile("weight.fit", noopConsumer({ onWeightBatch }))).rejects.toThrow(
      "FIT weight message is missing a valid timestamp",
    );
    expect(onWeightBatch).not.toHaveBeenCalled();
  });

  it("rejects duplicate metadata", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.send(metadataMessage());
    });

    await expect(streamFitFile("activity.fit", noopConsumer())).rejects.toThrow(
      "Native FIT decoder returned duplicate metadata",
    );
  });

  it("rejects end messages before metadata", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(() => decoder.send({ type: "end", messageCount: 0 }));

    await expect(streamFitFile("activity.fit", noopConsumer())).rejects.toThrow(
      "Native FIT decoder returned end before file metadata",
    );
  });

  it("rejects duplicate end messages", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "end", messageCount: 0 });
      decoder.send({ type: "end", messageCount: 0 });
    });

    await expect(streamFitFile("activity.fit", noopConsumer())).rejects.toThrow(
      "Native FIT decoder returned duplicate end messages",
    );
  });

  it("rejects record batches received after the end message", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    const onRecordBatch = vi.fn(async () => undefined);
    queueMicrotask(async () => {
      decoder.send({
        type: "metadata",
        fileType: 4,
        fileTypeName: "activity",
        hasWeightMessages: false,
        session: null,
        sportName: null,
        subSportName: null,
        fieldOccurrences: [],
      });
      await decoder.waitForAcknowledgement(1);
      decoder.send({ type: "end", messageCount: 1 });
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
      "Native FIT decoder returned records after its end message",
    );
    expect(onRecordBatch).not.toHaveBeenCalled();
  });

  it("rejects clean decoder exits before an end message", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.finish();
    });

    await expect(streamFitFile("activity.fit", noopConsumer())).rejects.toThrow(
      "Native FIT decoder exited before completing its protocol",
    );
  });

  it("rejects a final message count that differs from consumed messages", async () => {
    const decoder = simulatedDecoder();
    mockSpawn.mockReturnValue(decoder.child);
    queueMicrotask(async () => {
      decoder.send(metadataMessage());
      await decoder.waitForAcknowledgement(1);
      decoder.send({
        type: "records",
        messages: [{ timestamp: "2026-07-01T12:00:01.000Z", power: 250 }],
      });
      await decoder.waitForAcknowledgement(2);
      decoder.send({ type: "end", messageCount: 2 });
      decoder.finish();
    });

    await expect(streamFitFile("activity.fit", noopConsumer())).rejects.toThrow(
      "Native FIT decoder reported 2 messages after streaming 1",
    );
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
      fileTypeName: "activity",
      hasWeightMessages: false,
      session: null,
      sportName: null,
      subSportName: null,
      fieldOccurrences: [],
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
