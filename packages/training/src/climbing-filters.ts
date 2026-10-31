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
const settingSchema = climbSettingSchema.or(unknown);

/** Accept one or many choices at the API boundary; readers always receive arrays. */
function multipleChoice<T extends z.ZodType>(option: T, maximum: number) {
  return z
    .union([option, z.array(option).max(maximum)])
    .transform((value): z.infer<T>[] => (Array.isArray(value) ? value : [value]))
    .optional();
}

export const climbingFiltersSchema = z.object({
  climbKind: climbKindSchema.or(unknown).optional(),
  discipline: climbingDisciplineSchema.or(unknown).optional(),
  attemptScope: multipleChoice(attemptScopeSchema, 2),
  ropeMethod: ropeMethodSchema.or(unknown).optional(),
  solo: multipleChoice(z.boolean().nullable(), 3),
  protectionUsed: multipleChoice(protectionStyleSchema.or(unknown), 3),
  routeProtection: multipleChoice(protectionStyleSchema.or(unknown), 3),
  types: z
    .array(z.enum(["bouldering", "lead", "top_rope", "follow", "unroped"]))
    .max(5)
    .optional(),
  setting: multipleChoice(settingSchema, 3),
  board: multipleChoice(z.enum(["recorded", "not_recorded"]), 2),
});
export type ClimbingFilters = z.infer<typeof climbingFiltersSchema>;
export type ClimbingFilterKey = Exclude<keyof ClimbingFilters, "types">;

export const climbingAdvancedFilterKeys = [
  "attemptScope",
  "solo",
  "protectionUsed",
  "routeProtection",
] as const;
export type ClimbingAdvancedFilterKey = (typeof climbingAdvancedFilterKeys)[number];

export function isClimbingBoardFilterActive(filters: ClimbingFilters): boolean {
  return (
    filters.board !== undefined &&
    !(filters.board.includes("recorded") && filters.board.includes("not_recorded"))
  );
}

export function climbingFilterSelection(
  filters: ClimbingFilters,
  key: ClimbingAdvancedFilterKey | "board",
): ReadonlyArray<string | boolean | null> {
  return (
    filters[key] ??
    (key === "attemptScope" ? ["climb"] : climbingFilterOptions[key].map(([option]) => option))
  );
}

export function toggleClimbingFilter(
  filters: ClimbingFilters,
  key: ClimbingAdvancedFilterKey | "board",
  option: string | boolean | null,
): ClimbingFilters {
  const options = climbingFilterOptions[key].map(([value]) => value);
  const selected = climbingFilterSelection(filters, key);
  const values =
    option === "all"
      ? selected.length === options.length
        ? []
        : options
      : options.filter((value) =>
          value === option ? !selected.includes(value) : selected.includes(value),
        );
  const next = { ...filters };
  if (
    (key === "attemptScope" && values.length === 1 && values[0] === "climb") ||
    (key !== "attemptScope" && values.length === options.length)
  )
    delete next[key];
  else return climbingFiltersSchema.parse({ ...next, [key]: values });
  return next;
}

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
  ["follow", "Follow"],
  ["unroped", "Unroped"],
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
  const board = !isClimbingBoardFilterActive(filters)
    ? ""
    : filters.board?.length === 0
      ? "No board selection"
      : climbingFilterOptions.board
          .filter(([value]) => filters.board?.includes(value))
          .map(([, label]) => label)
          .join(" + ");
  return `${types} · ${settings}${board ? ` · ${board}` : ""}`;
}

export const climbingFilterLabels: Record<ClimbingFilterKey, string> = {
  climbKind: "Climb kind",
  discipline: "Discipline",
  attemptScope: "Attempt scope",
  ropeMethod: "Rope method",
  solo: "Solo status",
  protectionUsed: "Protection used",
  routeProtection: "Route protection",
  setting: "Setting",
  board: "Board",
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
    [null, "Unknown"],
  ],
  protectionUsed: [
    ["sport", "Sport"],
    ["trad", "Trad"],
    ["unknown", "Unknown"],
  ],
  routeProtection: [
    ["sport", "Sport"],
    ["trad", "Trad"],
    ["unknown", "Unknown"],
  ],
  setting: [
    ["indoor", "Indoor"],
    ["outdoor", "Outdoor"],
    ["unknown", "Unknown setting"],
  ],
  board: [
    ["recorded", "Board climbs"],
    ["not_recorded", "No board recorded"],
  ],
} as const;
