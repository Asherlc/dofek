import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("./index");

const { native } = vi.hoisted(() => ({
  native: {
    listPendingFiles: vi.fn<() => Promise<string[]>>(),
    readFile: vi.fn<(name: string) => Promise<unknown>>(),
    deleteFile: vi.fn<(name: string) => void>(),
  },
}));

vi.mock("./src/WearMotionModule", () => ({ default: native }));

import { deleteFile, listPendingFiles, readFile } from "./index";

describe("Wear OS pending file bridge", () => {
  beforeEach(() => {
    native.listPendingFiles.mockReset();
    native.readFile.mockReset();
    native.deleteFile.mockReset();
  });

  it("exposes only Wear motion files from the durable inbox", async () => {
    native.listPendingFiles.mockResolvedValue([
      "wear-motion-1.json.gz",
      "unrelated.json.gz",
      "wear-motion-2.json.gz",
    ]);

    await expect(listPendingFiles()).resolves.toEqual([
      "wear-motion-1.json.gz",
      "wear-motion-2.json.gz",
    ]);
  });

  it("rejects an unsafe file name before native file access", async () => {
    await expect(readFile("../escape.json")).rejects.toThrow("Invalid pending watch file name");
    expect(native.readFile).not.toHaveBeenCalled();
  });

  it("uses an acknowledged delete after a valid file is processed", async () => {
    native.readFile.mockResolvedValue([]);

    await expect(readFile("wear-motion-1.json.gz")).resolves.toEqual([]);
    deleteFile("wear-motion-1.json.gz");

    expect(native.readFile).toHaveBeenCalledWith("wear-motion-1.json.gz");
    expect(native.deleteFile).toHaveBeenCalledWith("wear-motion-1.json.gz");
  });
});
