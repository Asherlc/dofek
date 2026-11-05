import { describe, expect, it } from "vitest";
import { readMetricStreamArchiveLines } from "./archive-lines.ts";

async function* chunks(values: readonly Buffer[]) {
  yield* values;
}
describe("readMetricStreamArchiveLines", () => {
  it("preserves exact bytes and physical ordinals across split delimiters", async () => {
    const lines = [];
    for await (const line of readMetricStreamArchiveLines(
      chunks([Buffer.from(" A\r"), Buffer.from("\n\nB"), Buffer.from("\nC")]),
      4,
    ))
      lines.push([line.lineOrdinal, line.payload.toString("hex")]);
    expect(lines).toEqual([
      [1, "20410d"],
      [2, ""],
      [3, "42"],
      [4, "43"],
    ]);
  });
  it("admits the exact supported byte boundary and rejects the next byte before yielding", async () => {
    const payload = Buffer.alloc(900000, 120);
    const iterator = readMetricStreamArchiveLines(chunks([payload, Buffer.from("\n")]), 900000);
    expect((await iterator.next()).value?.payload).toEqual(payload);
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
