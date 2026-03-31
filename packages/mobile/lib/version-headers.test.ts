import { beforeEach, describe, expect, it, vi } from "vitest";

const updatesMock = vi.hoisted(
  (): { manifest: unknown; runtimeVersion: string | null; updateId: string | null } => ({
    manifest: { version: "1.2.3" },
    runtimeVersion: "1.0",
    updateId: "update-123",
  }),
);

vi.mock("expo-updates", () => updatesMock);

import { getVersionHeaders } from "./version-headers";

describe("getVersionHeaders", () => {
  beforeEach(() => {
    updatesMock.manifest = { version: "1.2.3" };
    updatesMock.runtimeVersion = "1.0";
    updatesMock.updateId = "update-123";
  });

  it("returns app version from manifest and assets version from update id", () => {
    const headers = getVersionHeaders();
    expect(headers).toEqual({
      "x-app-version": "1.2.3",
      "x-assets-version": "update-123",
    });
  });

  it("falls back when manifest version or update id is missing", () => {
    updatesMock.manifest = null;
    updatesMock.runtimeVersion = "1.0-runtime";
    updatesMock.updateId = null;

    const headers = getVersionHeaders();
    expect(headers).toEqual({
      "x-app-version": "1.0-runtime",
      "x-assets-version": "embedded",
    });
  });
});
