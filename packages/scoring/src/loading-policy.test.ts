import { describe, expect, it } from "vitest";
import { shouldShowBlockingLoading } from "./loading-policy.ts";

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

  it("keeps existing object data visible while loading", () => {
    expect(
      shouldShowBlockingLoading({
        data: { value: 1 },
        isLoading: true,
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

  it("shows blocking loading for an empty array on the first request", () => {
    expect(
      shouldShowBlockingLoading({
        data: [],
        isLoading: true,
        isFetching: true,
      }),
    ).toBe(true);
  });

  it("shows blocking loading when an empty query is fetching for the first time", () => {
    expect(
      shouldShowBlockingLoading({
        data: null,
        isLoading: false,
        isFetching: true,
      }),
    ).toBe(true);
  });

  it("does not block when no query is loading or fetching", () => {
    expect(
      shouldShowBlockingLoading({
        data: null,
        isLoading: false,
      }),
    ).toBe(false);
  });
});
