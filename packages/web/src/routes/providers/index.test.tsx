import { beforeAll, describe, expect, it, vi } from "vitest";

const captured = vi.hoisted<{ beforeLoad: (() => unknown) | null }>(() => ({
  beforeLoad: null,
}));
const mockRedirect = vi.hoisted(() => vi.fn((options: unknown) => options));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { beforeLoad?: () => unknown }) => {
    captured.beforeLoad = options.beforeLoad ?? null;
    return options;
  },
  redirect: mockRedirect,
}));

beforeAll(async () => {
  await import("./index.tsx");
});

describe("providers index redirect", () => {
  it("opens the Settings connections tab", () => {
    expect(() => captured.beforeLoad?.()).toThrow();
    expect(mockRedirect).toHaveBeenCalledWith({
      to: "/settings",
      search: { tab: "data-sources" },
    });
  });
});
