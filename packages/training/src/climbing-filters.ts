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
  types: z.array(z.enum(["bouldering", "lead", "top_rope"])).optional(),
  setting: z.array(climbSettingSchema.or(unknown)).optional(),
});
export type ClimbingFilters = z.infer<typeof climbingFiltersSchema>;
export type ClimbingFilterKey = Exclude<keyof ClimbingFilters, "types">;

/** Omitted settings select everything; an empty selection selects nothing. */
export function toggleClimbingSetting(
  filters: ClimbingFilters,
  setting: NonNullable<ClimbingFilters["setting"]>[number] | "all",
): ClimbingFilters {
  const options = climbingFilterOptions.setting.map(([option]) => option);
  const selected = filters.setting ?? options;
  const next = { ...filters };
  const values =
    setting === "all"
      ? selected.length === options.length
        ? []
        : options
      : options.filter((option) =>
          option === setting ? !selected.includes(option) : selected.includes(option),
        );
  if (values.length === options.length) delete next.setting;
  else next.setting = values;
  return next;
}

export const climbingTypeOptions = [
  ["bouldering", "Bouldering"],
  ["lead", "Lead"],
  ["top_rope", "Top rope"],
] as const;

export function toggleClimbingType(
  filters: ClimbingFilters,
  type: NonNullable<ClimbingFilters["types"]>[number] | "all",
): ClimbingFilters {
  const options = climbingTypeOptions.map(([value]) => value);
  const selected = filters.types ?? options;
  const values =
    type === "all"
      ? selected.length === options.length
        ? []
        : options
      : options.filter((option) =>
          option === type ? !selected.includes(option) : selected.includes(option),
        );
  const next = { ...filters };
  if (values.length === options.length) delete next.types;
  else next.types = values;
  return next;
}

export function climbingFilterSummary(filters: ClimbingFilters): string {
  const types =
    filters.types === undefined
      ? "All climbing"
      : filters.types.length === 0
        ? "No climbing types"
        : climbingTypeOptions
            .filter(([value]) => filters.types?.includes(value))
            .map(([, label]) => label)
            .join(" + ");
  const settings =
    filters.setting === undefined
      ? "All settings"
      : filters.setting.length === 0
        ? "No settings"
        : climbingFilterOptions.setting
            .filter(([value]) => filters.setting?.includes(value))
            .map(([, label]) => label)
            .join(" + ");
  return `${types} · ${settings}`;
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
