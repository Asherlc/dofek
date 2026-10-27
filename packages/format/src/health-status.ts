interface HealthStatusLabel {
  metric: string;
  statusLabel: string;
  intent: "higher" | "lower" | "maintain" | "neutral";
}

export function formatHealthStatusLabel(metric: HealthStatusLabel): string {
  if (metric.metric !== "trend_weight" || metric.intent === "neutral") return metric.statusLabel;
  const goal =
    metric.intent === "lower"
      ? "Weight loss goal"
      : metric.intent === "higher"
        ? "Weight gain goal"
        : "Weight maintenance goal";
  return `${metric.statusLabel} · ${goal}`;
}
