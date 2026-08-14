import posthog from "posthog-js";

type LogLevel = "info" | "warn" | "error";

function emitBrowserLog(
  level: LogLevel,
  category: string,
  message: string,
  data?: Record<string, unknown>,
) {
  posthog.capture("client_log", {
    level,
    category,
    message,
    platform: "web",
    ...data,
  });
}

/** Structured browser logger that forwards logs to PostHog. */
export const logger = {
  info(category: string, message: string, data?: Record<string, unknown>) {
    emitBrowserLog("info", category, message, data);
  },
  warn(category: string, message: string, data?: Record<string, unknown>) {
    emitBrowserLog("warn", category, message, data);
  },
  error(category: string, message: string, data?: Record<string, unknown>) {
    emitBrowserLog("error", category, message, data);
  },
};
