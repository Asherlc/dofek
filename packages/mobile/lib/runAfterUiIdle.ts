export type RunAfterUiIdleHandle = {
  cancel: () => void;
};

const DEFAULT_IDLE_TIMEOUT_MS = 2_000;

/**
 * Schedule non-urgent work after the UI thread has had a chance to handle taps and animations.
 * Uses React Native's supported idle callback API instead of deprecated InteractionManager.
 */
export function runAfterUiIdle(
  task: () => void,
  timeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
): RunAfterUiIdleHandle {
  const requestIdle = globalThis.requestIdleCallback;
  const cancelIdle = globalThis.cancelIdleCallback;

  if (typeof requestIdle === "function") {
    const id = requestIdle(task, { timeout: timeoutMs });
    return {
      cancel: () => {
        if (typeof cancelIdle === "function") {
          cancelIdle(id);
        }
      },
    };
  }

  const timerId = setTimeout(task, 0);
  return {
    cancel: () => {
      clearTimeout(timerId);
    },
  };
}
