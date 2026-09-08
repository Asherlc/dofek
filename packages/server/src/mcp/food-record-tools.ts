import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { NUTRIENT_FIELD_BY_ID } from "dofek/db/nutrient-columns";
import { foodCategoryEnum, mealEnum } from "dofek/db/schema/enums";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { FoodRecordRepository } from "../repositories/food-record-repository.ts";
import type {
  EffectiveFoodRecord,
  FoodRecordHistoryItem,
  FoodRecordHistoryPage,
} from "../repositories/food-record-types.ts";
import {
  FoodRecordError,
  type FoodRecordMutationResult,
  FoodRecordService,
} from "../services/food-record-service.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { mcpOutputSchemas } from "./tool-output.ts";
import { jsonToolError, jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

const nutrientIds = new Set(Object.keys(NUTRIENT_FIELD_BY_ID));
const nutrientIdSchema = z.string().refine((value) => nutrientIds.has(value), {
  message: "Unknown canonical nutrient ID",
});
const nutrientAmountSchema = z.number().finite().nonnegative();
const nullableNutrientAmountSchema = nutrientAmountSchema.nullable();
const nullableNonemptyTextSchema = z.string().trim().min(1).nullable();
const editableFieldSchema = z.enum([
  "date",
  "meal",
  "food_name",
  "food_description",
  "category",
  "number_of_units",
  "serving_unit",
  "serving_weight_grams",
]);
const foodRecordCursorSchema = z.object({
  date: dateSchema,
  record_id: z.uuid(),
});
const targetInputSchema = {
  record_id: z.uuid(),
  expected_version: z.uuid().nullable(),
  request_id: z.uuid(),
};

const readAnnotations = { readOnlyHint: true, openWorldHint: false } as const;
const mutationAnnotations = {
  readOnlyHint: false,
  openWorldHint: false,
  destructiveHint: false,
  idempotentHint: true,
} as const;

function foodRecordToTransport(record: EffectiveFoodRecord) {
  return {
    record_id: record.recordId,
    source_entry_id: record.sourceEntryId,
    version: record.version,
    deleted: record.deleted,
    modifiable: record.modifiable,
    modification_unavailable_reason: record.modificationUnavailableReason,
    date: record.date,
    meal: record.meal,
    food_name: record.foodName,
    food_description: record.foodDescription,
    category: record.category,
    number_of_units: record.numberOfUnits,
    serving_unit: record.servingUnit,
    serving_weight_grams: record.servingWeightGrams,
    nutrients: record.nutrients,
    source_provider: record.sourceProvider,
    provenance: Object.fromEntries(
      Object.entries(record.provenance).map(([field, provenance]) => [
        field,
        { origin: provenance.origin, change_id: provenance.changeId },
      ]),
    ),
  };
}

function historyItemToTransport(item: FoodRecordHistoryItem) {
  return {
    change_id: item.changeId,
    request_id: item.requestId,
    version: item.version,
    predecessor_version: item.predecessorVersion,
    kind: item.kind,
    channel: item.channel,
    client_id: item.clientId,
    recorded_at: item.recordedAt,
    effective_at: item.effectiveAt,
    schema_version: item.schemaVersion,
    undo_change_id: item.undoChangeId,
    deleted: item.deleted,
    fields: item.fields,
    nutrients: item.nutrients,
  };
}

function historyToTransport(page: FoodRecordHistoryPage) {
  return {
    record_id: page.recordId,
    items: page.items.map(historyItemToTransport),
    next_cursor: page.nextCursor,
  };
}

function mutationToTransport(result: FoodRecordMutationResult) {
  return {
    operation: {
      change_id: result.operation.changeId,
      resulting_version: result.operation.resultingVersion,
      replayed: result.operation.replayed,
    },
    record: foodRecordToTransport(result.record),
  };
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeDetailValueToTransport(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safeDetailValueToTransport);
  return isObjectRecord(value) ? safeDetailsToTransport(value) : value;
}

function safeDetailsToTransport(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      camelToSnake(key),
      safeDetailValueToTransport(entry),
    ]),
  );
}

async function foodToolResult<T>(
  operation: () => Promise<T>,
): Promise<ReturnType<typeof jsonToolResult> | ReturnType<typeof jsonToolError>> {
  try {
    return jsonToolResult(await operation());
  } catch (error: unknown) {
    if (error instanceof FoodRecordError) {
      const details = safeDetailsToTransport(error.details);
      return jsonToolError(
        error.code,
        error.message,
        Object.keys(details).length === 0 ? undefined : details,
      );
    }
    captureException(error);
    return jsonToolError("INTERNAL_ERROR", "The food record request could not be completed.");
  }
}

function requireMutationScopes(context: DofekMcpContext): void {
  requireMcpScope(context.scopes, "nutrition:read");
  requireMcpScope(context.scopes, "nutrition:write");
}

function dateRangeToolError(
  startDate: string,
  endDate: string,
): ReturnType<typeof jsonToolError> | null {
  try {
    assertDateRange(startDate, endDate);
    return null;
  } catch (error: unknown) {
    if (error instanceof Error) return jsonToolError("INVALID_ARGUMENT", error.message);
    captureException(error);
    return jsonToolError("INTERNAL_ERROR", "The food record request could not be completed.");
  }
}

function scalarSetToDomain(set: {
  date?: string;
  meal?: (typeof mealEnum.enumValues)[number] | null;
  food_name?: string | null;
  food_description?: string | null;
  category?: (typeof foodCategoryEnum.enumValues)[number] | null;
  number_of_units?: number | null;
  serving_unit?: string | null;
  serving_weight_grams?: number | null;
}) {
  return {
    ...(set.date !== undefined ? { date: set.date } : {}),
    ...(set.meal !== undefined ? { meal: set.meal } : {}),
    ...(set.food_name !== undefined ? { foodName: set.food_name } : {}),
    ...(set.food_description !== undefined ? { foodDescription: set.food_description } : {}),
    ...(set.category !== undefined ? { category: set.category } : {}),
    ...(set.number_of_units !== undefined ? { numberOfUnits: set.number_of_units } : {}),
    ...(set.serving_unit !== undefined ? { servingUnit: set.serving_unit } : {}),
    ...(set.serving_weight_grams !== undefined
      ? { servingWeightGrams: set.serving_weight_grams }
      : {}),
  };
}

function editableFieldToDomain(field: z.infer<typeof editableFieldSchema>) {
  const fieldNames = {
    date: "date",
    meal: "meal",
    food_name: "foodName",
    food_description: "foodDescription",
    category: "category",
    number_of_units: "numberOfUnits",
    serving_unit: "servingUnit",
    serving_weight_grams: "servingWeightGrams",
  } as const;
  return fieldNames[field];
}

export function registerFoodRecordTools(server: McpServer, context: DofekMcpContext): void {
  const repository = new FoodRecordRepository(context.db, context.userId);
  const service = new FoodRecordService({
    database: context.db,
    userId: context.userId,
    actor: { channel: "mcp", clientId: context.clientId },
  });

  server.registerTool(
    "search_food_entries",
    {
      title: "Search Food Entries",
      description: "Search effective food records in an exact date range.",
      annotations: readAnnotations,
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        query: z.string().trim().min(1).nullable().optional(),
        visibility: z.enum(["visible", "deleted", "all"]).optional(),
        cursor: foodRecordCursorSchema.nullable().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: mcpOutputSchemas.foodRecordSearch,
    },
    async ({ start_date, end_date, query, visibility, cursor, limit }) => {
      requireMcpScope(context.scopes, "nutrition:read");
      const rangeError = dateRangeToolError(start_date, end_date);
      if (rangeError) return rangeError;
      return foodToolResult(async () => {
        const result = await repository.search({
          startDate: start_date,
          endDate: end_date,
          query: query ?? null,
          visibility: visibility ?? "visible",
          cursor: cursor ? { date: cursor.date, recordId: cursor.record_id } : null,
          limit: limit ?? 50,
        });
        return {
          items: result.items.map(foodRecordToTransport),
          next_cursor: result.nextCursor
            ? { date: result.nextCursor.date, record_id: result.nextCursor.recordId }
            : null,
        };
      });
    },
  );

  server.registerTool(
    "get_food_entry",
    {
      title: "Get Food Entry",
      description: "Return one effective food record with its provenance and version.",
      annotations: readAnnotations,
      inputSchema: { record_id: z.uuid() },
      outputSchema: mcpOutputSchemas.foodRecordDetail,
    },
    async ({ record_id }) => {
      requireMcpScope(context.scopes, "nutrition:read");
      return foodToolResult(async () => {
        const record = await repository.get(record_id);
        return record ? foodRecordToTransport(record) : null;
      });
    },
  );

  server.registerTool(
    "create_food_entry",
    {
      title: "Create Food Entry",
      description: "Create one itemized Dofek food record.",
      annotations: mutationAnnotations,
      inputSchema: {
        request_id: z.uuid(),
        date: dateSchema,
        meal: z.enum(mealEnum.enumValues).nullable().optional(),
        food_name: z.string().trim().min(1),
        food_description: nullableNonemptyTextSchema.optional(),
        category: z.enum(foodCategoryEnum.enumValues).nullable().optional(),
        number_of_units: z.number().finite().nonnegative().nullable().optional(),
        serving_unit: nullableNonemptyTextSchema.optional(),
        serving_weight_grams: z.number().finite().nonnegative().nullable().optional(),
        nutrients: z.record(nutrientIdSchema, nutrientAmountSchema),
      },
      outputSchema: mcpOutputSchemas.foodRecordMutation,
    },
    async ({
      request_id,
      date,
      meal,
      food_name,
      food_description,
      category,
      number_of_units,
      serving_unit,
      serving_weight_grams,
      nutrients,
    }) => {
      requireMutationScopes(context);
      return foodToolResult(async () =>
        mutationToTransport(
          await service.create({
            requestId: request_id,
            date,
            meal,
            foodName: food_name,
            foodDescription: food_description,
            category,
            numberOfUnits: number_of_units,
            servingUnit: serving_unit,
            servingWeightGrams: serving_weight_grams,
            nutrients,
          }),
        ),
      );
    },
  );

  server.registerTool(
    "update_food_entry",
    {
      title: "Update Food Entry",
      description: "Append validated scalar and nutrient decisions to a food record.",
      annotations: mutationAnnotations,
      inputSchema: {
        ...targetInputSchema,
        set: z.object({
          date: dateSchema.optional(),
          meal: z.enum(mealEnum.enumValues).nullable().optional(),
          food_name: nullableNonemptyTextSchema.optional(),
          food_description: nullableNonemptyTextSchema.optional(),
          category: z.enum(foodCategoryEnum.enumValues).nullable().optional(),
          number_of_units: z.number().finite().nonnegative().nullable().optional(),
          serving_unit: nullableNonemptyTextSchema.optional(),
          serving_weight_grams: z.number().finite().nonnegative().nullable().optional(),
        }),
        clear: z.array(editableFieldSchema),
        nutrient_set: z.record(nutrientIdSchema, nullableNutrientAmountSchema),
        nutrient_clear: z.array(nutrientIdSchema),
      },
      outputSchema: mcpOutputSchemas.foodRecordMutation,
    },
    async ({
      record_id,
      expected_version,
      request_id,
      set,
      clear,
      nutrient_set,
      nutrient_clear,
    }) => {
      requireMutationScopes(context);
      return foodToolResult(async () =>
        mutationToTransport(
          await service.update({
            recordId: record_id,
            expectedVersion: expected_version,
            requestId: request_id,
            set: scalarSetToDomain(set),
            clear: clear.map(editableFieldToDomain),
            nutrientSet: nutrient_set,
            nutrientClear: nutrient_clear,
          }),
        ),
      );
    },
  );

  const registerTargetMutation = (
    name: "delete_food_entry" | "restore_food_entry",
    title: string,
    description: string,
    operation: (input: {
      recordId: string;
      expectedVersion: string | null;
      requestId: string;
    }) => Promise<FoodRecordMutationResult>,
  ) => {
    server.registerTool(
      name,
      {
        title,
        description,
        annotations: {
          ...mutationAnnotations,
          destructiveHint: name === "delete_food_entry",
        },
        inputSchema: targetInputSchema,
        outputSchema: mcpOutputSchemas.foodRecordMutation,
      },
      async ({ record_id, expected_version, request_id }) => {
        requireMutationScopes(context);
        return foodToolResult(async () =>
          mutationToTransport(
            await operation({
              recordId: record_id,
              expectedVersion: expected_version,
              requestId: request_id,
            }),
          ),
        );
      },
    );
  };

  registerTargetMutation(
    "delete_food_entry",
    "Delete Food Entry",
    "Append a deletion tombstone to a food record.",
    (input) => service.delete(input),
  );
  registerTargetMutation(
    "restore_food_entry",
    "Restore Food Entry",
    "Restore a deleted food record while retaining its field decisions.",
    (input) => service.restore(input),
  );

  server.registerTool(
    "get_food_entry_history",
    {
      title: "Get Food Entry History",
      description: "Return paginated food record operations and provenance.",
      annotations: readAnnotations,
      inputSchema: {
        record_id: z.uuid(),
        cursor: z.string().nullable().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      outputSchema: mcpOutputSchemas.foodRecordHistory,
    },
    async ({ record_id, cursor, limit }) => {
      requireMcpScope(context.scopes, "nutrition:read");
      return foodToolResult(async () =>
        historyToTransport(await repository.history(record_id, cursor ?? null, limit ?? 50)),
      );
    },
  );
}
