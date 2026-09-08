import { z } from "zod";
import { dateStringSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export const foodRecordVisibilitySchema = z.enum(["visible", "deleted", "all"]);

export const foodRecordCursorSchema = z.object({
  date: dateStringSchema,
  recordId: z.uuid(),
});

export const foodRecordSearchInputSchema = z.object({
  startDate: dateStringSchema,
  endDate: dateStringSchema,
  query: z.string().trim().min(1).nullable(),
  visibility: foodRecordVisibilitySchema,
  cursor: foodRecordCursorSchema.nullable(),
  limit: z.number().int().min(1).max(100),
});

export interface FoodRecordProvenance {
  origin: "source" | "human";
  changeId: string | null;
}

export interface EffectiveFoodRecord {
  recordId: string;
  sourceEntryId: string;
  version: string | null;
  deleted: boolean;
  modifiable: boolean;
  modificationUnavailableReason: string | null;
  date: string;
  meal: string | null;
  foodName: string | null;
  foodDescription: string | null;
  category: string | null;
  numberOfUnits: number | null;
  servingUnit: string | null;
  servingWeightGrams: number | null;
  nutrients: Record<string, number | null>;
  sourceProvider: string;
  provenance: Record<string, FoodRecordProvenance>;
}

export const foodRecordProvenanceSchema = z.object({
  origin: z.enum(["source", "human"]),
  changeId: z.uuid().nullable(),
});

export const effectiveFoodRecordSchema: z.ZodType<EffectiveFoodRecord> = z.object({
  recordId: z.uuid(),
  sourceEntryId: z.uuid(),
  version: z.uuid().nullable(),
  deleted: z.boolean(),
  modifiable: z.boolean(),
  modificationUnavailableReason: z.string().nullable(),
  date: dateStringSchema,
  meal: z.string().nullable(),
  foodName: z.string().nullable(),
  foodDescription: z.string().nullable(),
  category: z.string().nullable(),
  numberOfUnits: z.number().nullable(),
  servingUnit: z.string().nullable(),
  servingWeightGrams: z.number().nullable(),
  nutrients: z.record(z.string(), z.number().nullable()),
  sourceProvider: z.string(),
  provenance: z.record(z.string(), foodRecordProvenanceSchema),
});

export const foodRecordSearchResultSchema = z.object({
  items: z.array(effectiveFoodRecordSchema),
  nextCursor: foodRecordCursorSchema.nullable(),
});

export const foodRecordFieldDecisionSchema = z.union([
  z
    .object({
      operation: z.literal("set"),
      value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
  z.object({ operation: z.literal("clear") }).strict(),
]);

export const foodRecordNutrientDecisionSchema = z.object({
  operation: z.enum(["set", "clear"]),
  amount: z.number().nullable(),
});

export const foodRecordHistoryItemSchema = z.object({
  changeId: z.uuid(),
  requestId: z.uuid(),
  version: z.uuid(),
  predecessorVersion: z.uuid().nullable(),
  kind: z.enum(["create", "update", "clear", "delete", "restore", "undo", "legacy_delete"]),
  channel: z.enum(["web", "mobile", "mcp", "migration"]),
  clientId: z.string().nullable(),
  recordedAt: timestampStringSchema,
  effectiveAt: timestampStringSchema.nullable(),
  schemaVersion: z.number().int().positive(),
  undoChangeId: z.uuid().nullable(),
  deleted: z.boolean().nullable(),
  fields: z.record(z.string(), foodRecordFieldDecisionSchema),
  nutrients: z.record(z.string(), foodRecordNutrientDecisionSchema),
});

export const foodRecordHistoryPageSchema = z.object({
  recordId: z.uuid(),
  items: z.array(foodRecordHistoryItemSchema),
  nextCursor: z.string().nullable(),
});

export type FoodRecordVisibility = z.infer<typeof foodRecordVisibilitySchema>;
export type FoodRecordCursor = z.infer<typeof foodRecordCursorSchema>;
export type FoodRecordSearchInput = z.infer<typeof foodRecordSearchInputSchema>;
export type FoodRecordSearchResult = z.infer<typeof foodRecordSearchResultSchema>;
export type FoodRecordFieldDecision = z.infer<typeof foodRecordFieldDecisionSchema>;
export type FoodRecordNutrientDecision = z.infer<typeof foodRecordNutrientDecisionSchema>;
export type FoodRecordHistoryItem = z.infer<typeof foodRecordHistoryItemSchema>;
export type FoodRecordHistoryPage = z.infer<typeof foodRecordHistoryPageSchema>;

export class FoodRecordPreconditionError extends Error {
  readonly code = "PRECONDITION_FAILED";

  constructor(
    readonly sourceEntryId: string,
    message = "This food entry has no stable provider external ID and cannot be modified safely.",
  ) {
    super(message);
    this.name = "FoodRecordPreconditionError";
  }
}
