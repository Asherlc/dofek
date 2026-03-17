import { describe, expect, it } from "vitest";
import { type LogEntry, RingBuffer } from "./ring-buffer-transport.ts";

describe("RingBuffer", () => {
  it("stores log entries", () => {
    const buf = new RingBuffer(10);
    buf.push({ level: "info", message: "hello", timestamp: "2026-01-01T00:00:00Z" });

    const entries = buf.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].level).toBe("info");
    expect(entries[0].message).toBe("hello");
  });

  it("evicts oldest entries when full", () => {
    const buf = new RingBuffer(3);
    for (let i = 0; i < 5; i++) {
      buf.push({ level: "info", message: `msg-${i}`, timestamp: `2026-01-01T00:00:0${i}Z` });
    }

    const entries = buf.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].message).toBe("msg-2");
    expect(entries[1].message).toBe("msg-3");
    expect(entries[2].message).toBe("msg-4");
  });

  it("returns entries in chronological order", () => {
    const buf = new RingBuffer(5);
    buf.push({ level: "info", message: "first", timestamp: "2026-01-01T00:00:00Z" });
    buf.push({ level: "error", message: "second", timestamp: "2026-01-01T00:00:01Z" });
    buf.push({ level: "warn", message: "third", timestamp: "2026-01-01T00:00:02Z" });

    const entries = buf.getEntries();
    expect(entries.map((e: LogEntry) => e.message)).toEqual(["first", "second", "third"]);
  });

  it("defaults to 500 max entries", () => {
    const buf = new RingBuffer();
    expect(buf.maxSize).toBe(500);
  });

  it("returns empty array when no entries", () => {
    const buf = new RingBuffer();
    expect(buf.getEntries()).toEqual([]);
  });

  it("preserves all log info fields", () => {
    const buf = new RingBuffer(10);
    buf.push({ level: "error", message: "something broke", timestamp: "2026-01-01T00:00:00Z" });

    const entry = buf.getEntries()[0];
    expect(entry).toMatchObject({
      level: "error",
      message: "something broke",
      timestamp: "2026-01-01T00:00:00Z",
    });
  });
});
