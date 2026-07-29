import { isCyclingActivity } from "./training.ts";

export type ActivityIconCategory =
  | "cycling"
  | "running"
  | "swimming"
  | "walking"
  | "strength"
  | "yoga"
  | "hiit"
  | "elliptical"
  | "rowing"
  | "winter"
  | "climbing"
  | "water"
  | "team"
  | "dance"
  | "other";

export interface ActivityIconInfo {
  category: ActivityIconCategory;
  emoji: string;
  gradientFrom: string;
  gradientTo: string;
}

const CATEGORY_INFO: Record<
  ActivityIconCategory,
  Pick<ActivityIconInfo, "emoji" | "gradientFrom" | "gradientTo">
> = {
  cycling: { emoji: "\u{1F6B4}", gradientFrom: "#2563eb", gradientTo: "#1d4ed8" },
  running: { emoji: "\u{1F3C3}", gradientFrom: "#ea580c", gradientTo: "#c2410c" },
  swimming: { emoji: "\u{1F3CA}", gradientFrom: "#0891b2", gradientTo: "#0e7490" },
  walking: { emoji: "\u{1F6B6}", gradientFrom: "#16a34a", gradientTo: "#15803d" },
  strength: { emoji: "\u{1F3CB}\u{FE0F}", gradientFrom: "#7c3aed", gradientTo: "#6d28d9" },
  yoga: { emoji: "\u{1F9D8}", gradientFrom: "#db2777", gradientTo: "#be185d" },
  hiit: { emoji: "\u{1F4A5}", gradientFrom: "#dc2626", gradientTo: "#b91c1c" },
  elliptical: {
    emoji: "\u{1F3C3}\u{200D}\u{2642}\u{FE0F}",
    gradientFrom: "#059669",
    gradientTo: "#047857",
  },
  rowing: { emoji: "\u{1F6A3}", gradientFrom: "#0284c7", gradientTo: "#0369a1" },
  winter: { emoji: "\u{26F7}\u{FE0F}", gradientFrom: "#6366f1", gradientTo: "#4f46e5" },
  climbing: { emoji: "\u{1F9D7}", gradientFrom: "#78716c", gradientTo: "#57534e" },
  water: { emoji: "\u{1F3C4}", gradientFrom: "#06b6d4", gradientTo: "#0891b2" },
  team: { emoji: "\u{26BD}", gradientFrom: "#65a30d", gradientTo: "#4d7c0f" },
  dance: { emoji: "\u{1F483}", gradientFrom: "#d946ef", gradientTo: "#a21caf" },
  other: { emoji: "\u{26A1}", gradientFrom: "#6b7280", gradientTo: "#4b5563" },
};

export function resolveActivityIconCategory(activityType: string): ActivityIconCategory {
  const lower = activityType.trim().toLowerCase();

  if (isCyclingActivity(lower)) return "cycling";
  if (lower.includes("run") || lower.includes("trail")) return "running";
  if (lower.includes("swim") || lower.includes("triathlon")) return "swimming";
  if (lower.includes("walk") || lower.includes("hiking") || lower.includes("stair"))
    return "walking";
  if (
    lower.includes("strength") ||
    lower.includes("weight") ||
    lower.includes("functional_fitness") ||
    lower.includes("bootcamp") ||
    lower.includes("core") ||
    lower.includes("circuit") ||
    lower.includes("box") ||
    lower.includes("martial")
  ) {
    return "strength";
  }
  if (
    lower.includes("yoga") ||
    lower.includes("pilates") ||
    lower.includes("meditation") ||
    lower.includes("mind") ||
    lower.includes("stretch")
  ) {
    return "yoga";
  }
  if (lower.includes("hiit") || lower.includes("cross_training") || lower.includes("cardio")) {
    return "hiit";
  }
  if (lower.includes("elliptical")) return "elliptical";
  if (lower.includes("rowing")) return "rowing";
  if (
    lower.includes("ski") ||
    lower.includes("skating") ||
    lower.includes("snow") ||
    lower.includes("curling") ||
    lower.includes("ice_hockey")
  ) {
    return "winter";
  }
  if (lower.includes("climb")) return "climbing";
  if (
    lower.includes("surf") ||
    lower.includes("kayak") ||
    lower.includes("paddl") ||
    lower.includes("aqua") ||
    lower.includes("water")
  ) {
    return "water";
  }
  if (
    lower.includes("tennis") ||
    lower.includes("basketball") ||
    lower.includes("soccer") ||
    lower.includes("football") ||
    lower.includes("hockey") ||
    lower.includes("ball") ||
    lower.includes("golf") ||
    lower.includes("pickleball") ||
    lower.includes("badminton") ||
    lower.includes("volleyball") ||
    lower.includes("cricket") ||
    lower.includes("rugby") ||
    lower.includes("lacrosse") ||
    lower.includes("handball") ||
    lower.includes("baseball") ||
    lower.includes("softball")
  ) {
    return "team";
  }
  if (lower === "dance" || lower === "dancing") return "dance";

  return "other";
}

export function getActivityIconInfo(activityType: string): ActivityIconInfo {
  const category = resolveActivityIconCategory(activityType);
  return {
    category,
    ...CATEGORY_INFO[category],
  };
}
