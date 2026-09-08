import { z } from "zod";

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();
const jsonResult = <T extends z.ZodType>(result: T) => z.object({ result });

const foodRecordProvenanceOutputSchema = z.object({
  origin: z.enum(["source", "human"]),
  change_id: z.uuid().nullable(),
});

export const foodRecordOutputSchema = z.object({
  record_id: z.uuid(),
  source_entry_id: z.uuid(),
  version: z.uuid().nullable(),
  deleted: z.boolean(),
  modifiable: z.boolean(),
  modification_unavailable_reason: nullableString,
  date: z.string(),
  meal: nullableString,
  food_name: nullableString,
  food_description: nullableString,
  category: nullableString,
  number_of_units: nullableNumber,
  serving_unit: nullableString,
  serving_weight_grams: nullableNumber,
  nutrients: z.record(z.string(), nullableNumber),
  source_provider: z.string(),
  provenance: z.record(z.string(), foodRecordProvenanceOutputSchema),
});

export const foodRecordSearchOutputSchema = jsonResult(
  z.object({
    items: z.array(foodRecordOutputSchema),
    next_cursor: z
      .object({
        record_id: z.uuid(),
      })
      .nullable(),
  }),
);

export const foodRecordDetailOutputSchema = jsonResult(foodRecordOutputSchema.nullable());

const foodRecordFieldDecisionOutputSchema = z.union([
  z.object({
    operation: z.literal("set"),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({ operation: z.literal("clear") }),
]);

const foodRecordHistoryItemOutputSchema = z.object({
  change_id: z.uuid(),
  request_id: z.uuid(),
  version: z.uuid(),
  predecessor_version: z.uuid().nullable(),
  kind: z.enum(["create", "update", "clear", "delete", "restore", "undo", "legacy_delete"]),
  channel: z.enum(["web", "mobile", "mcp", "migration"]),
  client_id: nullableString,
  recorded_at: z.string(),
  effective_at: nullableString,
  schema_version: z.number().int().positive(),
  undo_change_id: z.uuid().nullable(),
  deleted: z.boolean().nullable(),
  fields: z.record(z.string(), foodRecordFieldDecisionOutputSchema),
  nutrients: z.record(
    z.string(),
    z.object({
      operation: z.enum(["set", "clear"]),
      amount: nullableNumber,
    }),
  ),
});

export const foodRecordHistoryOutputSchema = jsonResult(
  z.object({
    record_id: z.uuid(),
    items: z.array(foodRecordHistoryItemOutputSchema),
    next_cursor: nullableString,
  }),
);

export const foodRecordMutationOutputSchema = jsonResult(
  z.object({
    operation: z.object({
      change_id: z.uuid(),
      resulting_version: z.uuid(),
      replayed: z.boolean(),
    }),
    record: foodRecordOutputSchema,
  }),
);
