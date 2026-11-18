import {
  activityDataStateSchema,
  activityDataStateUnavailableStatusSchema,
} from "@dofek/format/activity-data-state";
import { recordLocalTimeContextSchema } from "@dofek/format/record-local-time";
import { activityOriginSchema } from "@dofek/providers/activity-origin";
import { activitySourceTreeSchema } from "@dofek/providers/activity-source-tree";
import { z } from "zod";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { activityLocationSchema } from "./activity-location.ts";

const activityStatSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("available"),
    label: z.string(),
    value: z.string(),
  }),
  z.object({
    status: activityDataStateUnavailableStatusSchema,
    label: z.string(),
    reason: z.string().trim().min(1),
  }),
]);

const activityListSourceSchema = z.object({
  origin: activityOriginSchema,
  primarySourceLabel: z.string().nullable(),
  sourceCount: z.number().int().positive(),
  overlapSummary: z.string().nullable(),
  tree: activitySourceTreeSchema,
});

export const calendarActivityEntrySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  activityType: z.string(),
  primaryActivityType: z.string().nullable(),
  modality: z.string().nullable(),
  startedAt: timestampStringSchema,
  endedAt: timestampStringSchema.nullable(),
  localTimeContext: recordLocalTimeContextSchema,
  durationMin: z.number().nullable(),
  source: activityListSourceSchema,
  lastProcessedAt: timestampStringSchema.nullable(),
  distanceMeters: z.number().nullable(),
  distanceState: activityDataStateSchema,
  elevationGainM: z.number().nullable(),
  elevationState: activityDataStateSchema,
  location: activityLocationSchema.nullable(),
  tss: z.number().nullable(),
  stats: z.array(activityStatSchema),
  isProviderAbsent: z.boolean().optional(),
  providerId: z.string().optional(),
  providerAbsentAt: timestampStringSchema.nullable().optional(),
  partialAbsentSources: z
    .array(
      z.object({
        providerId: z.string(),
        providerAbsentAt: timestampStringSchema.nullable(),
        subsource: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

export const datedCalendarActivityEntrySchema = calendarActivityEntrySchema.extend({
  date: dateStringSchema,
});
