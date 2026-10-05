import { z } from "zod";

export const climbingFilterOptions = {
  style: [
    ["boulder", "Boulder"],
    ["route", "Routes"],
    ["lead", "Lead"],
    ["top-rope", "Top rope"],
    ["follow", "Follow"],
    ["solo", "Solo"],
    ["aid", "Aid"],
    ["unknown", "Unknown style"],
  ],
  protection: [
    ["sport", "Sport"],
    ["trad", "Trad"],
    ["unknown", "Unknown protection"],
  ],
  setting: [
    ["indoor", "Indoor"],
    ["outdoor", "Outdoor"],
    ["unknown", "Unknown setting"],
  ],
} as const;

export const climbingFiltersSchema = z.object({
  style: z
    .enum(["boulder", "route", "lead", "top-rope", "follow", "solo", "aid", "unknown"])
    .optional(),
  protection: z.enum(["sport", "trad", "unknown"]).optional(),
  setting: z.enum(["indoor", "outdoor", "unknown"]).optional(),
});
export type ClimbingFilters = z.infer<typeof climbingFiltersSchema>;
export type ClimbingFilterKey = keyof ClimbingFilters;
