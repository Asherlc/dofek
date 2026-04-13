// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { BodyDaysContext, useBodyDays } from "./bodyDaysContext.ts";

describe("bodyDaysContext", () => {
  it("provides default days value of 30", () => {
    const { result } = renderHook(() => useBodyDays());
    expect(result.current.days).toBe(30);
  });

  it("returns provided context value", () => {
    const setDays = vi.fn();
    const wrapper = ({ children }: { children: React.ReactNode }) =>
      createElement(BodyDaysContext.Provider, { value: { days: 60, setDays } }, children);

    const { result } = renderHook(() => useBodyDays(), { wrapper });
    expect(result.current.days).toBe(60);
    result.current.setDays(90);
    expect(setDays).toHaveBeenCalledWith(90);
  });
});
