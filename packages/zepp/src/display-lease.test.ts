import { describe, expect, it, vi } from "vitest";
import { createDisplayLease } from "./display-lease.ts";

function dependencies() {
  return {
    pauseDropWristScreenOff: vi.fn(() => 0),
    resetDropWristScreenOff: vi.fn(() => 0),
    setPageBrightTime: vi.fn(() => 0),
    resetPageBrightTime: vi.fn(() => 0),
  };
}

describe("createDisplayLease", () => {
  it("acquires and releases the complete foreground display policy exactly once", () => {
    const deps = dependencies();
    const lease = createDisplayLease(deps);

    lease.acquire();
    lease.acquire();
    lease.release();
    lease.release();

    expect(deps.pauseDropWristScreenOff).toHaveBeenCalledOnce();
    expect(deps.pauseDropWristScreenOff).toHaveBeenCalledWith({ duration: 0 });
    expect(deps.setPageBrightTime).toHaveBeenCalledOnce();
    expect(deps.setPageBrightTime).toHaveBeenCalledWith({ brightTime: 2_147_483_000 });
    expect(deps.resetPageBrightTime).toHaveBeenCalledOnce();
    expect(deps.resetDropWristScreenOff).toHaveBeenCalledOnce();
  });

  it("rolls back wrist behavior when the bright-time lease fails", () => {
    const deps = dependencies();
    deps.setPageBrightTime.mockReturnValue(1);
    const lease = createDisplayLease(deps);

    expect(() => lease.acquire()).toThrow("Unable to keep the recorder display awake.");
    expect(deps.resetDropWristScreenOff).toHaveBeenCalledOnce();
    expect(lease.acquired).toBe(false);
  });

  it("does not change brightness when suspending wrist-drop screen-off fails", () => {
    const deps = dependencies();
    deps.pauseDropWristScreenOff.mockReturnValue(1);
    const lease = createDisplayLease(deps);

    expect(() => lease.acquire()).toThrow("Unable to suspend wrist-drop screen-off.");
    expect(deps.setPageBrightTime).not.toHaveBeenCalled();
    expect(deps.resetDropWristScreenOff).not.toHaveBeenCalled();
    expect(lease.acquired).toBe(false);
  });

  it("attempts both release operations when one reset fails", () => {
    const deps = dependencies();
    deps.resetPageBrightTime.mockReturnValue(1);
    const lease = createDisplayLease(deps);
    lease.acquire();

    expect(() => lease.release()).toThrow("Unable to restore the display timeout.");
    expect(deps.resetDropWristScreenOff).toHaveBeenCalledOnce();
    expect(lease.acquired).toBe(false);
  });

  it("reports wrist restoration failure after restoring the display timeout", () => {
    const deps = dependencies();
    deps.resetDropWristScreenOff.mockReturnValue(1);
    const lease = createDisplayLease(deps);
    lease.acquire();

    expect(() => lease.release()).toThrow("Unable to restore wrist-drop screen-off.");
    expect(deps.resetPageBrightTime).toHaveBeenCalledOnce();
    expect(deps.resetDropWristScreenOff).toHaveBeenCalledOnce();
    expect(lease.acquired).toBe(false);
  });
});
