const MAX_PAGE_BRIGHT_TIME_MS = 2_147_483_000;

interface DisplayLeaseDependencies {
  pauseDropWristScreenOff(options: { duration: number }): number;
  resetDropWristScreenOff(): number;
  setPageBrightTime(options: { brightTime: number }): number;
  resetPageBrightTime(): number;
}

export interface DisplayLease {
  readonly acquired: boolean;
  acquire(): void;
  release(): void;
}

export function createDisplayLease(deps: DisplayLeaseDependencies): DisplayLease {
  let acquired = false;
  return {
    get acquired() {
      return acquired;
    },
    acquire() {
      if (acquired) {
        return;
      }
      if (deps.pauseDropWristScreenOff({ duration: 0 }) !== 0) {
        throw new Error("Unable to suspend wrist-drop screen-off.");
      }
      if (deps.setPageBrightTime({ brightTime: MAX_PAGE_BRIGHT_TIME_MS }) !== 0) {
        deps.resetDropWristScreenOff();
        throw new Error("Unable to keep the recorder display awake.");
      }
      acquired = true;
    },
    release() {
      if (!acquired) {
        return;
      }
      acquired = false;
      const brightResult = deps.resetPageBrightTime();
      const wristResult = deps.resetDropWristScreenOff();
      if (brightResult !== 0) {
        throw new Error("Unable to restore the display timeout.");
      }
      if (wristResult !== 0) {
        throw new Error("Unable to restore wrist-drop screen-off.");
      }
    },
  };
}
