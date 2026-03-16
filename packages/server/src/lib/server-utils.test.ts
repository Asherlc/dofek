import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { assembleChunks, errorMessage, streamToFile } from "./server-utils.ts";

describe("errorMessage", () => {
  it("extracts message from Error instances", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error values", () => {
    expect(errorMessage("string error")).toBe("string error");
    expect(errorMessage(42)).toBe("42");
    expect(errorMessage(null)).toBe("null");
    expect(errorMessage(undefined)).toBe("undefined");
  });
});

describe("streamToFile", () => {
  const tmpFiles: string[] = [];

  function tmpPath(name: string): string {
    const p = join(tmpdir(), `server-utils-test-${name}-${Date.now()}`);
    tmpFiles.push(p);
    return p;
  }

  afterEach(async () => {
    for (const f of tmpFiles) {
      await unlink(f).catch(() => {});
    }
    tmpFiles.length = 0;
  });

  it("writes request body to a file", async () => {
    const filePath = tmpPath("basic");
    const body = Buffer.from("hello world");
    const readable = Readable.from([body]);
    // Mock enough of express Request interface for streamToFile
    const req = Object.assign(readable, {
      headers: {},
      method: "POST",
      url: "/test",
    });

    await streamToFile(req, filePath);
    const contents = await readFile(filePath, "utf-8");
    expect(contents).toBe("hello world");
  });

  it("rejects when body exceeds max size", async () => {
    const filePath = tmpPath("oversize");
    const body = Buffer.alloc(100, "x");
    const readable = Readable.from([body]);
    const req = Object.assign(readable, {
      headers: {},
      method: "POST",
      url: "/test",
    });

    await expect(streamToFile(req, filePath, 50)).rejects.toThrow("Upload exceeds maximum size");
  });
});

describe("assembleChunks", () => {
  const tmpPaths: string[] = [];

  function tmpPath(name: string): string {
    const p = join(tmpdir(), `assemble-test-${name}-${Date.now()}`);
    tmpPaths.push(p);
    return p;
  }

  afterEach(async () => {
    for (const f of tmpPaths) {
      await unlink(f).catch(() => {});
    }
    tmpPaths.length = 0;
  });

  it("concatenates chunk files in sorted order", async () => {
    const { mkdir, rm } = await import("node:fs/promises");
    const chunkDir = join(tmpdir(), `assemble-chunks-test-${Date.now()}`);
    await mkdir(chunkDir, { recursive: true });

    await writeFile(join(chunkDir, "chunk-000000"), "AAA");
    await writeFile(join(chunkDir, "chunk-000001"), "BBB");
    await writeFile(join(chunkDir, "chunk-000002"), "CCC");
    // Non-chunk file should be ignored
    await writeFile(join(chunkDir, "other-file"), "IGNORED");

    const outputPath = tmpPath("assembled");
    await assembleChunks(chunkDir, outputPath);

    const result = await readFile(outputPath, "utf-8");
    expect(result).toBe("AAABBBCCC");

    await rm(chunkDir, { recursive: true, force: true });
  });
});
