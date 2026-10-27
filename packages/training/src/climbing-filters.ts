import { z } from "zod";
import {
  attemptScopeSchema,
  climbingDisciplineSchema,
  climbKindSchema,
  climbSettingSchema,
  protectionStyleSchema,
  ropeMethodSchema,
} from "./climbing-log.ts";

const unknown = z.literal("unknown");
export const climbingFiltersSchema = z.object({
  climbKind: climbKindSchema.or(unknown).optional(),
  discipline: climbingDisciplineSchema.or(unknown).optional(),
  attemptScope: attemptScopeSchema.optional(),
  ropeMethod: ropeMethodSchema.or(unknown).optional(),
  solo: z.boolean().nullable().optional(),
  protectionUsed: protectionStyleSchema.or(unknown).optional(),
  routeProtection: protectionStyleSchema.or(unknown).optional(),
  setting: climbSettingSchema.or(unknown).optional(),
});
export type ClimbingFilters = z.infer<typeof climbingFiltersSchema>;
export type ClimbingFilterKey = keyof ClimbingFilters;

export const climbingContextPresets = [
  { value: "all", label: "All climbing" },
  { value: "bouldering", label: "Bouldering" },
  { value: "lead", label: "Lead" },
  { value: "top_rope", label: "Top rope" },
] as const;
type ClimbingContextPreset = (typeof climbingContextPresets)[number]["value"];

/** Context shortcuts select factual filters without changing independent facets. */
export function selectClimbingContext(
  filters: ClimbingFilters,
  context: ClimbingContextPreset,
): ClimbingFilters {
  const next = { ...filters };
  delete next.climbKind;
  delete next.ropeMethod;
  if (context === "bouldering") next.climbKind = "boulder";
  else if (context !== "all") {
    next.climbKind = "route";
    next.ropeMethod = context;
  }
  return next;
}

export function climbingContextPreset(filters: ClimbingFilters): ClimbingContextPreset | null {
  if (filters.climbKind === undefined && filters.ropeMethod === undefined) return "all";
  if (filters.climbKind === "boulder" && filters.ropeMethod === undefined) return "bouldering";
  if (
    filters.climbKind === "route" &&
    (filters.ropeMethod === "lead" || filters.ropeMethod === "top_rope")
  )
    return filters.ropeMethod;
  return null;
}

export const climbingFilterKeys = [
  "climbKind",
  "discipline",
  "attemptScope",
  "ropeMethod",
  "solo",
  "protectionUsed",
  "routeProtection",
  "setting",
] as const;
export const climbingFilterLabels: Record<ClimbingFilterKey, string> = {
  climbKind: "Climb kind",
  discipline: "Discipline",
  attemptScope: "Attempt scope",
  ropeMethod: "Rope method",
  solo: "Solo status",
  protectionUsed: "Protection used",
  routeProtection: "Route protection",
  setting: "Setting",
};

export const climbingFilterOptions = {
  climbKind: [
    ["boulder", "Boulder"],
    ["route", "Route"],
    ["summit", "Summit"],
    ["unknown", "Unknown kind"],
  ],
  discipline: [
    ["rock_climbing", "Rock climbing"],
    ["ice_climbing", "Ice climbing"],
    ["mixed_climbing", "Mixed climbing"],
    ["snow_climbing", "Snow climbing"],
    ["hiking", "Hiking"],
    ["scrambling", "Scrambling"],
    ["mountaineering", "Mountaineering"],
    ["unknown", "Unknown discipline"],
  ],
  attemptScope: [
    ["climb", "Whole climb"],
    ["pitch", "Pitch"],
  ],
  ropeMethod: [
    ["lead", "Lead"],
    ["top_rope", "Top rope"],
    ["follow", "Follow"],
    ["unroped", "Unroped"],
    ["unknown", "Unknown rope method"],
  ],
  solo: [
    [true, "Solo"],
    [false, "With a belayer"],
    [null, "Unknown solo status"],
  ],
  protectionUsed: [
    ["sport", "Sport"],
    ["trad", "Trad"],
    ["unknown", "Unknown protection used"],
  ],
  routeProtection: [
    ["sport", "Sport"],
    ["trad", "Trad"],
    ["unknown", "Unknown route protection"],
  ],
  setting: [
    ["indoor", "Indoor"],
    ["outdoor", "Outdoor"],
    ["unknown", "Unknown setting"],
  ],
} as const;
