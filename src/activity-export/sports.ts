import { isCyclingActivity } from "@dofek/training/training";

export function tcxSport(activityType: string): string {
  const normalized = activityType.trim().toLowerCase();
  if (isCyclingActivity(normalized)) return "Biking";
  if (normalized.includes("run")) return "Running";
  if (normalized.includes("walk") || normalized.includes("hik")) return "Walking";
  if (normalized.includes("swim")) return "Other";
  return "Other";
}

export function fitSport(activityType: string): string {
  const normalized = activityType.trim().toLowerCase();
  if (isCyclingActivity(normalized)) return "cycling";
  if (normalized.includes("run")) return "running";
  if (normalized.includes("walk") || normalized.includes("hik")) return "walking";
  if (normalized.includes("swim")) return "swimming";
  if (normalized.includes("strength") || normalized.includes("weight")) return "training";
  return "generic";
}
