import { afterEach, describe, expect, it, vi } from "vitest";
import { Default, Loading } from "./login.stories";

const originalFetch = globalThis.fetch;

async function installStoryFetch(story: typeof Default): Promise<() => void> {
  const beforeEachHook: unknown = story.beforeEach;
  if (typeof beforeEachHook !== "function") {
    throw new Error("Story beforeEach hook is missing");
  }
  const cleanup: unknown = await beforeEachHook({});
  if (typeof cleanup !== "function") {
    throw new Error("Story beforeEach hook did not return cleanup");
  }
  return cleanup;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Login stories", () => {
  it("delegates requests outside the configured-providers endpoint", async () => {
    const previousFetch = vi.fn(async () => new Response("delegated"));
    globalThis.fetch = previousFetch;
    const cleanup = await installStoryFetch(Default);

    const response = await globalThis.fetch("https://dofek.example/api/other");

    expect(await response.text()).toBe("delegated");
    expect(previousFetch).toHaveBeenCalledWith("https://dofek.example/api/other", undefined);
    cleanup();
  });

  it("only keeps the configured-providers request pending in the loading story", async () => {
    const previousFetch = vi.fn(async () => new Response("delegated"));
    globalThis.fetch = previousFetch;
    const cleanup = await installStoryFetch(Loading);

    const response = await globalThis.fetch("https://dofek.example/api/other");

    expect(await response.text()).toBe("delegated");
    expect(previousFetch).toHaveBeenCalledOnce();
    cleanup();
  });
});
