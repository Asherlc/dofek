import { describe, expect, it } from "vitest";
import { readMetricStreamArchiveLines } from "./archive-lines.ts";

async function* chunks(values: readonly Uint8Array[]) {
  yield* values;
}

describe("readMetricStreamArchiveLines", () => {
  it("preserves accumulated bytes when a source reuses its yielded buffer", async () => {
    const reused = Buffer.alloc(2);
    async function* source() {
      reused.write("ab");
      yield reused;
      reused.write("c\n");
      yield reused;
    }
    const lines = [];
    for await (const line of readMetricStreamArchiveLines(source(), 4)) lines.push(line);
    expect(lines).toEqual([{ payload: Buffer.from("abc"), lineOrdinal: 1, terminated: true }]);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid %s-byte bound before reading the source",
    async (bound) => {
      let pulled = false;
      async function* source() {
        pulled = true;
        yield Buffer.from("record\n");
      }
      await expect(readMetricStreamArchiveLines(source(), bound).next()).rejects.toThrow(
        "Archive line byte limit must be a positive safe integer",
      );
      expect(pulled).toBe(false);
    },
  );

  it.each(["", "a\n", "\n"])("does not invent a final record after %j", async (input) => {
    const lines = [];
    for await (const line of readMetricStreamArchiveLines(chunks([Buffer.from(input)]), 4))
      lines.push(line);
    expect(lines).toEqual(
      input.length
        ? [{ payload: Buffer.from(input.slice(0, -1)), lineOrdinal: 1, terminated: true }]
        : [],
    );
  });

  it("identifies the exact physical line that exceeds its byte bound", async () => {
    const iterator = readMetricStreamArchiveLines(chunks([Buffer.from("ok\nxxx")]), 2);
    expect((await iterator.next()).value).toEqual({
      payload: Buffer.from("ok"),
      lineOrdinal: 1,
      terminated: true,
    });
    await expect(iterator.next()).rejects.toThrow(
      "Archive line payload exceeds its 2-byte limit at line 2; contact support before retrying",
    );
  });

  it("preserves exact bytes, LF termination and physical ordinals across chunk boundaries", async () => {
    const lines = [];
    for await (const line of readMetricStreamArchiveLines(
      chunks([Buffer.from(" A\r"), new Uint8Array([10, 10, 66]), Buffer.from("\n\rC")]),
      4,
    ))
      lines.push([line.lineOrdinal, line.payload.toString("hex"), line.terminated]);
    expect(lines).toEqual([
      [1, "20410d", true],
      [2, "", true],
      [3, "42", true],
      [4, "0d43", false],
    ]);
  });

  it("admits the exact supported byte boundary and rejects the next byte before yielding", async () => {
    const payload = Buffer.alloc(900000, 120);
    const iterator = readMetricStreamArchiveLines(chunks([payload, Buffer.from("\n")]), 900000);
    expect((await iterator.next()).value).toEqual({ payload, lineOrdinal: 1, terminated: true });
    await iterator.return(undefined);
    const oversized = readMetricStreamArchiveLines(chunks([payload, Buffer.from("x\n")]), 900000);
    await expect(oversized.next()).rejects.toThrow("900000-byte limit");
  });

  it("does not pull another source chunk while a yielded record is pending", async () => {
    let pulled = 0;
    let closed = false;
    async function* source() {
      try {
        for (let index = 0; index < 10; index++) {
          pulled += 1;
          yield Buffer.from("record\n");
        }
      } finally {
        closed = true;
      }
    }
    const iterator = readMetricStreamArchiveLines(source(), 100);
    await iterator.next();
    expect(pulled).toBe(1);
    await iterator.return(undefined);
    expect(closed).toBe(true);
    expect(pulled).toBe(1);
  });
});
