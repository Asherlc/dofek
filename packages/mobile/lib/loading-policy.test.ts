import { describe, expect, it } from "vitest";
import { shouldShowBlockingLoading } from "./loading-policy";

describe("shouldShowBlockingLoading", () => {
  it("keeps existing rows visible while a background refetch is active", () => {
    expect(
      shouldShowBlockingLoading({
        data: [{ value: 1 }],
        isLoading: false,
        isFetching: true,
      }),
    ).toBe(false);
  });

  it("shows blocking loading only when the first request has no data yet", () => {
    expect(
      shouldShowBlockingLoading({
        data: null,
        isLoading: true,
        isFetching: true,
      }),
    ).toBe(true);
  });
});
