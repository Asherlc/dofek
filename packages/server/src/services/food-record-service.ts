import { createHash } from "node:crypto";
import type { Database, TransactionDatabase } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { NUTRIENT_FIELD_BY_ID } from "dofek/db/nutrient-columns";
import { foodCategoryEnum, mealEnum } from "dofek/db/schema/enums";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { invalidateNutritionCaches as defaultInvalidateNutritionCaches } from "../lib/nutrition-cache.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import {
  type AppendFoodRecordChangeInput,
  type FoodRecordActor,
  FoodRecordConflictError,
  FoodRecordNotFoundError,
  FoodRecordRepository,
  type FoodRecordRepositoryCommands,
} from "../repositories/food-record-repository.ts";
import {
  type EffectiveFoodRecord,
  type FoodRecordFieldDecision,
  FoodRecordPreconditionError,
} from "../repositories/food-record-types.ts";

const nutrientIds = new Set(Object.keys(NUTRIENT_FIELD_BY_ID));
const nutrientIdSchema = z.string().refine((value) => nutrientIds.has(value), {
  message: "Unknown canonical nutrient ID",
});
const nutrientAmountSchema = z.number().finite().nonnegative();
const nullableNutrientAmountSchema = nutrientAmountSchema.nullable();
const nonemptyTextSchema = z.string().trim().min(1);
const nullableTextSchema = nonemptyTextSchema.nullable();
const mealSchema = z.enum(mealEnum.enumValues);
const categorySchema = z.enum(foodCategoryEnum.enumValues);
const editableFieldSchema = z.enum([
  "date",
  "meal",
  "foodName",
  "foodDescription",
  "category",
  "numberOfUnits",
  "servingUnit",
  "servingWeightGrams",
]);

const createFoodRecordSchema = z
  .object({
    requestId: z.uuid(),
    date: dateStringSchema,
    meal: mealSchema.nullable().optional(),
    foodName: nonemptyTextSchema,
    foodDescription: nullableTextSchema.optional(),
    category: categorySchema.nullable().optional(),
    numberOfUnits: z.number().finite().nonnegative().nullable().optional(),
    servingUnit: nullableTextSchema.optional(),
    servingWeightGrams: z.number().finite().nonnegative().nullable().optional(),
    nutrients: z.record(nutrientIdSchema, nutrientAmountSchema),
  })
  .strict();

const scalarSetSchema = z
  .object({
    date: dateStringSchema.optional(),
    meal: mealSchema.nullable().optional(),
    foodName: nullableTextSchema.optional(),
    foodDescription: nullableTextSchema.optional(),
    category: categorySchema.nullable().optional(),
    numberOfUnits: z.number().finite().nonnegative().nullable().optional(),
    servingUnit: nullableTextSchema.optional(),
    servingWeightGrams: z.number().finite().nonnegative().nullable().optional(),
  })
  .strict();

const updateFoodRecordSchema = z
  .object({
    recordId: z.uuid(),
    expectedVersion: z.uuid().nullable(),
    requestId: z.uuid(),
    set: scalarSetSchema,
    clear: z.array(editableFieldSchema),
    nutrientSet: z.record(nutrientIdSchema, nullableNutrientAmountSchema),
    nutrientClear: z.array(nutrientIdSchema),
  })
  .strict()
  .superRefine((input, context) => {
    const setFields = new Set(Object.keys(input.set));
    for (const field of input.clear) {
      if (setFields.has(field)) {
        context.addIssue({
          code: "custom",
          path: ["clear"],
          message: `${field} cannot be both set and cleared`,
        });
      }
    }
    const setNutrients = new Set(Object.keys(input.nutrientSet));
    for (const nutrient of input.nutrientClear) {
      if (setNutrients.has(nutrient)) {
        context.addIssue({
          code: "custom",
          path: ["nutrientClear"],
          message: `${nutrient} cannot be both set and cleared`,
        });
      }
    }
    if (
      setFields.size === 0 &&
      input.clear.length === 0 &&
      setNutrients.size === 0 &&
      input.nutrientClear.length === 0
    ) {
      context.addIssue({ code: "custom", message: "Update must contain at least one decision" });
    }
  })
  .transform((input) => ({
    ...input,
    clear: [...new Set(input.clear)].sort(),
    nutrientClear: [...new Set(input.nutrientClear)].sort(),
  }));

const targetCommandSchema = z
  .object({
    recordId: z.uuid(),
    expectedVersion: z.uuid().nullable(),
    requestId: z.uuid(),
  })
  .strict();

export type CreateFoodRecordInput = z.input<typeof createFoodRecordSchema>;
export type UpdateFoodRecordInput = z.input<typeof updateFoodRecordSchema>;
export type TargetFoodRecordInput = z.input<typeof targetCommandSchema>;

export type FoodRecordErrorCode =
  | "NOT_FOUND"
  | "PRECONDITION_FAILED"
  | "CONFLICT"
  | "INVALID_ARGUMENT"
  | "ACCOUNT_ERASURE_ACTIVE";

export class FoodRecordError extends Error {
  readonly code: FoodRecordErrorCode;
  readonly details: Record<string, unknown>;

  constructor(
    code: FoodRecordErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FoodRecordError";
    this.code = code;
    this.details = details;
  }
}

export interface FoodRecordMutationResult {
  operation: {
    changeId: string;
    resultingVersion: string;
    replayed: boolean;
  };
  record: EffectiveFoodRecord;
  affectedDates: string[];
}

type WriteFence = <T>(
  database: Pick<Database, "transaction">,
  userId: string,
  operation: (transaction: TransactionDatabase) => Promise<T>,
) => Promise<T>;

interface FoodRecordServiceDependencies {
  database: Pick<Database, "transaction">;
  userId: string;
  actor: FoodRecordActor;
  invalidateNutritionCaches?: (userId: string) => Promise<void>;
  repositoryFactory?: (
    database: Pick<Database, "execute" | "transaction">,
    userId: string,
  ) => FoodRecordRepositoryCommands;
  withUserWriteFence?: WriteFence;
}

const fieldNames: Record<string, string> = {
  date: "date",
  meal: "meal",
  foodName: "food_name",
  foodDescription: "food_description",
  category: "category",
  numberOfUnits: "number_of_units",
  servingUnit: "serving_unit",
  servingWeightGrams: "serving_weight_grams",
};

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry)]),
  );
}

function requestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalValue(value)))
    .digest("hex");
}

function sortedDates(...dates: string[]): string[] {
  return [...new Set(dates)].sort();
}

function requireRecord(
  record: EffectiveFoodRecord | null,
  recordId: string,
  version: string | null,
): EffectiveFoodRecord {
  if (record) return record;
  throw new Error(`Food record snapshot ${recordId}@${version ?? "source"} was not found`);
}

function parseCommand<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new FoodRecordError("INVALID_ARGUMENT", "The food record command is invalid.", {
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function mapDomainError(error: unknown): never {
  if (error instanceof FoodRecordError) throw error;
  if (error instanceof FoodRecordNotFoundError) {
    throw new FoodRecordError(
      "NOT_FOUND",
      error.message,
      { recordId: error.recordId },
      { cause: error },
    );
  }
  if (error instanceof FoodRecordPreconditionError) {
    throw new FoodRecordError(
      "PRECONDITION_FAILED",
      error.message,
      { sourceEntryId: error.sourceEntryId },
      { cause: error },
    );
  }
  if (error instanceof FoodRecordConflictError) {
    throw new FoodRecordError(
      "CONFLICT",
      error.message,
      { recordId: error.recordId, currentVersion: error.currentVersion },
      { cause: error },
    );
  }
  if (error instanceof AccountErasureUserFencedError) {
    throw new FoodRecordError(
      "ACCOUNT_ERASURE_ACTIVE",
      "Account deletion is active. Wait for deletion to complete before changing food records.",
      {},
      { cause: error },
    );
  }
  captureException(new Error("FoodRecordService command failed"));
  throw error;
}

export class FoodRecordService {
  readonly #database: Pick<Database, "transaction">;
  readonly #userId: string;
  readonly #actor: FoodRecordActor;
  readonly #invalidateNutritionCaches: (userId: string) => Promise<void>;
  readonly #repositoryFactory: NonNullable<FoodRecordServiceDependencies["repositoryFactory"]>;
  readonly #withUserWriteFence: WriteFence;

  constructor(dependencies: FoodRecordServiceDependencies) {
    this.#database = dependencies.database;
    this.#userId = dependencies.userId;
    this.#actor = dependencies.actor;
    this.#invalidateNutritionCaches =
      dependencies.invalidateNutritionCaches ?? defaultInvalidateNutritionCaches;
    this.#repositoryFactory =
      dependencies.repositoryFactory ??
      ((database, userId) => new FoodRecordRepository(database, userId));
    this.#withUserWriteFence = dependencies.withUserWriteFence ?? withAccountErasureUserWriteFence;
  }

  async create(input: CreateFoodRecordInput): Promise<FoodRecordMutationResult> {
    const command = parseCommand(createFoodRecordSchema, input);
    const { requestId: _requestId, ...hashedCommand } = command;
    const hash = requestHash({ kind: "create", actor: this.#actor, payload: hashedCommand });
    try {
      const outcome = await this.#withUserWriteFence(
        this.#database,
        this.#userId,
        async (transaction) => {
          const repository = this.#repositoryFactory(transaction, this.#userId);
          const head = await repository.createSourceAndIdentity({
            ...command,
            externalId: `mcp:${command.requestId}`,
            requestHash: hash,
            actor: this.#actor,
          });
          const record = requireRecord(
            await repository.get(head.identityId),
            head.identityId,
            head.version,
          );
          return {
            result: {
              operation: {
                changeId: head.changeId,
                resultingVersion: head.version,
                replayed: head.replayed,
              },
              record,
              affectedDates: head.replayed ? [] : [record.date],
            },
            replayed: head.replayed,
          };
        },
      );
      if (!outcome.replayed) await this.#invalidateNutritionCaches(this.#userId);
      return outcome.result;
    } catch (error: unknown) {
      return mapDomainError(error);
    }
  }

  async update(input: UpdateFoodRecordInput): Promise<FoodRecordMutationResult> {
    const command = parseCommand(updateFoodRecordSchema, input);
    const fields: Record<string, FoodRecordFieldDecision> = {};
    for (const [name, value] of Object.entries(command.set)) {
      const field = fieldNames[name];
      if (field) fields[field] = { operation: "set", value };
    }
    for (const name of command.clear) {
      const field = fieldNames[name];
      if (field) fields[field] = { operation: "clear" };
    }
    const nutrients: AppendFoodRecordChangeInput["nutrients"] = {};
    for (const [nutrientId, amount] of Object.entries(command.nutrientSet)) {
      nutrients[nutrientId] = { operation: "set", amount };
    }
    for (const nutrientId of command.nutrientClear) {
      nutrients[nutrientId] = { operation: "clear", amount: null };
    }
    return this.#append(command, "update", fields, nutrients, null);
  }

  async delete(input: TargetFoodRecordInput): Promise<FoodRecordMutationResult> {
    return this.#append(parseCommand(targetCommandSchema, input), "delete", {}, {}, true);
  }

  async restore(input: TargetFoodRecordInput): Promise<FoodRecordMutationResult> {
    return this.#append(parseCommand(targetCommandSchema, input), "restore", {}, {}, false);
  }

  async #append(
    command: z.output<typeof targetCommandSchema> | z.output<typeof updateFoodRecordSchema>,
    kind: "update" | "delete" | "restore",
    fields: Record<string, FoodRecordFieldDecision>,
    nutrients: AppendFoodRecordChangeInput["nutrients"],
    deleted: boolean | null,
  ): Promise<FoodRecordMutationResult> {
    const { requestId: _requestId, ...hashedCommand } = command;
    const hash = requestHash({ kind, actor: this.#actor, payload: hashedCommand });
    try {
      const outcome = await this.#withUserWriteFence(
        this.#database,
        this.#userId,
        async (transaction) => {
          const repository = this.#repositoryFactory(transaction, this.#userId);
          const head = await repository.appendChange({
            identityId: command.recordId,
            expectedVersion: command.expectedVersion,
            requestId: command.requestId,
            requestHash: hash,
            kind,
            actor: this.#actor,
            fields,
            nutrients,
            deleted,
          });
          const record = requireRecord(
            await repository.get(head.identityId),
            head.identityId,
            head.version,
          );
          const affectedDates = head.replayed
            ? []
            : kind === "update"
              ? sortedDates(
                  requireRecord(
                    await repository.getAtVersion(head.identityId, head.predecessorVersion),
                    head.identityId,
                    head.predecessorVersion,
                  ).date,
                  record.date,
                )
              : [record.date];
          return {
            result: {
              operation: {
                changeId: head.changeId,
                resultingVersion: head.version,
                replayed: head.replayed,
              },
              record,
              affectedDates,
            },
            replayed: head.replayed,
          };
        },
      );
      if (!outcome.replayed) await this.#invalidateNutritionCaches(this.#userId);
      return outcome.result;
    } catch (error: unknown) {
      return mapDomainError(error);
    }
  }
}
