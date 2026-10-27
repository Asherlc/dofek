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
