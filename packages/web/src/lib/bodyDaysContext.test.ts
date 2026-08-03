// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BodyDaysContext, useBodyDays } from "./bodyDaysContext.ts";

describe("bodyDaysContext", () => {
  it("fails explicitly when the provider is missing", () => {
    expect(() => renderHook(() => useBodyDays())).toThrow(
      "useBodyDays must be used within BodyDaysContext.Provider",
    );
  });

  it("returns provided context value", () => {
    const setDays = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(
        BodyDaysContext.Provider,
        { value: { days: 60, description: "Recent body changes.", setDays } },
        children,
      );

    const { result } = renderHook(() => useBodyDays(), { wrapper });
    expect(result.current.days).toBe(60);
    result.current.setDays(90);
    expect(setDays).toHaveBeenCalledWith(90);
  });

  it("allows All to be represented as null", () => {
    const setDays = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(
        BodyDaysContext.Provider,
        { value: { days: null, description: "Recent body changes.", setDays } },
        children,
      );

    const { result } = renderHook(() => useBodyDays(), { wrapper });
    expect(result.current.days).toBeNull();
    result.current.setDays(null);
    expect(setDays).toHaveBeenCalledWith(null);
  });
});
