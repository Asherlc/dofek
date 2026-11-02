/**
 * Standard duration constants and presentation labels for power curves.
 *
 * Shared between web and iOS via @dofek/training.
 */

// ── Standard durations for power curves ─────────────────────

export const STANDARD_DURATIONS = [
  5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200,
];

/** Human-readable labels for standard duration curve durations. */
export const DURATION_LABELS: Record<number, string> = {
  5: "5s",
  15: "15s",
  30: "30s",
  60: "1min",
  120: "2min",
  180: "3min",
  300: "5min",
  420: "7min",
  600: "10min",
  1200: "20min",
  1800: "30min",
  3600: "60min",
  5400: "90min",
  7200: "120min",
};
