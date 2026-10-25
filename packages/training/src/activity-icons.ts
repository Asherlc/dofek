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
  | "hangboard"
  | "water"
  | "team"
  | "dance"
  | "other";

export interface ActivityIconInfo {
  category: ActivityIconCategory;
  svg: string;
  gradientFrom: string;
  gradientTo: string;
}

// Original Dofek outline geometry, shared by web and native renderers.
const CATEGORY_INFO: Record<ActivityIconCategory, Omit<ActivityIconInfo, "category">> = {
  cycling: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><g stroke-width="1.9"><circle cx="7.5" cy="23.5" r="5.2"/><circle cx="24.5" cy="23.5" r="5.2"/></g><path stroke="currentColor" stroke-width="1.9" d="M7.5 23.5 13 13l6.5 10.5h-12M13 13h8.5l3 10.5M21.5 13l-2-6H16M11 10h5m-2.5 0L13 13"/></svg>',
    gradientFrom: "#2563eb",
    gradientTo: "#1d4ed8",
  },
  running: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="20" cy="5.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m17 11-3 7 8 3 3 7M16 12l-5-1-4 5m10-5 5 5 5-2M14 18l-3 8H5"/></svg>',
    gradientFrom: "#ea580c",
    gradientTo: "#c2410c",
  },
  swimming: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="14" r="2.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m7 18 7-9 7 2M7 18l8-2 5 3"/><path stroke="currentColor" stroke-width="1.9" d="M3 23c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0M3 28c2-2 4-2 6 0s4 2 6 0 4-2 6 0 4 2 6 0"/></svg>',
    gradientFrom: "#0891b2",
    gradientTo: "#0e7490",
  },
  walking: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.4"/><path d="m16 10-3 8 5 3 3 8M15 12l-5 3-4-1m10-4 4 6 5 2M13 18l-2 8-4 3"/></svg>',
    gradientFrom: "#16a34a",
    gradientTo: "#15803d",
  },
  strength: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 16h12"/><g fill="none" stroke="currentColor" stroke-width="1.9"><rect x="5" y="9" width="5" height="14" rx="1.3"/><rect x="22" y="9" width="5" height="14" rx="1.3"/><rect x="2" y="12" width="3" height="8" rx="1"/><rect x="27" y="12" width="3" height="8" rx="1"/></g></svg>',
    gradientFrom: "#7c3aed",
    gradientTo: "#6d28d9",
  },
  yoga: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="7" r="2.4"/><path d="M12 13h8l3 7 5 2m-16-9-3 7-5 2m12-9v8m0 0-6 3c-4 2-3 5 1 5h10c4 0 5-3 1-5l-6-3m-6 8 6-3 6 3"/></svg>',
    gradientFrom: "#db2777",
    gradientTo: "#be185d",
  },
  hiit: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="m18 3-11 15h8l-1 11 11-16h-8l1-10ZM5 6 3 4m24 22 2 2M3 23h3M26 8h3"/></svg>',
    gradientFrom: "#dc2626",
    gradientTo: "#b91c1c",
  },
  elliptical: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.4"/><path d="m16 10-4 8 8 3 2 6M16 11l5 4 4-5M12 18l-3 8M5 29h22M5 10l4 16m16-16-3 17"/><path d="M6 26h6m7 1h6"/></svg>',
    gradientFrom: "#059669",
    gradientTo: "#047857",
  },
  rowing: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="7" r="2.4"/><path d="m16 12-4 7 7 3 3-2M16 12l5 5 5-1M5 20h7m-3 4h18M10 9l14 20m-2-3 4-2m-1 5 3-2M3 28c2-1 4-1 6 0s4 1 6 0 4-1 6 0 4 1 6 0"/></svg>',
    gradientFrom: "#0284c7",
    gradientTo: "#0369a1",
  },
  winter: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="19" cy="5" r="2.4"/><path d="m17 10-6 7 10 4-3 6M17 10l4 5 5 1M8 28l16 2c3 0 4-1 5-2M10 12 4 27m22-15-1 15"/></svg>',
    gradientFrom: "#6366f1",
    gradientTo: "#4f46e5",
  },
  climbing: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="16.5" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="m15 14-3 7 8 2 2 6M15 14l6-3 1-7m-7 10-6-3-4 6m7 4-6 4-3-2"/><path stroke="currentColor" stroke-width="1.9" d="M21 2h4M2 18h4m14 12h5"/></svg>',
    gradientFrom: "#78716c",
    gradientTo: "#57534e",
  },
  hangboard: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="3" width="24" height="7" rx="2" fill="none" stroke="currentColor" stroke-width="1.9"/><path stroke="currentColor" stroke-width="1.8" d="M8 6.5h5m6 0h5"/><circle cx="16" cy="15" r="2.2" fill="none" stroke="currentColor" stroke-width="1.9"/><path d="M9 10v8l7 4 7-4v-8m-7 12v5m0 0-3 3m3-3 3 3"/></svg>',
    gradientFrom: "#78716c",
    gradientTo: "#57534e",
  },
  water: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.4"/><path d="m16 10-3 7 6 3 3 4m-9-7-3 7H7M16 11l-5 2-5-2m10 0 5 3 5-2M3 24c7 1 18 1 26-2-3 5-18 8-26 2ZM3 30c2-1 4-1 6 0s4 1 6 0 4-1 6 0 4 1 6 0"/></svg>',
    gradientFrom: "#06b6d4",
    gradientTo: "#0891b2",
  },
  team: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="16" r="12"/><path d="m16 10 5 4-2 6h-6l-2-6 5-4ZM16 10V4m5 10 6-2m-8 8 4 6m-10-6-4 6m2-12-6-2"/></svg>',
    gradientFrom: "#65a30d",
    gradientTo: "#4d7c0f",
  },
  dance: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.4"/><path d="m16 10-3 9 7 3 3 7M16 11l7 2 5-5m-12 3-6-3-5 4M13 19l-4 7-5-1m20-9 3 2M7 3 5 5"/></svg>',
    gradientFrom: "#d946ef",
    gradientTo: "#a21caf",
  },
  other: {
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="16" cy="16" r="12"/><path d="M7 16h5l3-7 3 14 3-7h4"/></svg>',
    gradientFrom: "#6b7280",
    gradientTo: "#4b5563",
  },
};

export function resolveActivityIconCategory(activityType: string): ActivityIconCategory {
  const lower = activityType.trim().toLowerCase();

  if (isCyclingActivity(lower)) return "cycling";
  if (lower === "hangboard" || lower === "hangboarding") return "hangboard";
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
    lower.includes("paddle") ||
    lower.includes("paddling") ||
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
