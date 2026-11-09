import { z } from "zod";

export const familySchema = z.enum(["activity", "sleep", "operation", "group_string"]);
export const identifierSchema = z.uuid().transform((value) => value.toLowerCase());
export const cursorSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const physicalFamilySchema = z.enum([
  "physical_intent",
  "physical_part",
  "physical_mutation",
]);
export const physicalStageSchema = z.enum(["initial", "final"]);
const physicalNameSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
const physicalBytesSchema = z
  .string()
  .min(1)
  .max(5464)
  .base64()
  .refine(
    (value) => Buffer.from(value, "base64").toString("base64") === value,
    "Physical metadata must use canonical exact-byte base64",
  );
const physicalBindingSchema = z.union([
  z.literal("user"),
  z
    .tuple([physicalNameSchema, familySchema, cursorSchema.nullable(), cursorSchema])
    .readonly()
    .refine(
      (value) => value[2] === null || value[2] < value[3],
      "Physical predicate bounds must increase",
    ),
]);
const physicalIntentSchema = z
  .tuple([
    physicalStageSchema,
    physicalNameSchema,
    physicalNameSchema,
    identifierSchema,
    cursorSchema,
    physicalBindingSchema,
  ])
  .readonly();
const physicalPartSchema = z
  .tuple([
    physicalStageSchema,
    physicalNameSchema,
    physicalNameSchema,
    identifierSchema,
    physicalBytesSchema,
  ])
  .readonly();
const physicalMutationSchema = z
  .tuple([physicalStageSchema, cursorSchema, physicalBytesSchema])
  .readonly();
export const physicalProgressSchema = z.discriminatedUnion("step", [
  z.strictObject({
    step: z.literal("apply"),
    afterIntentKey: cursorSchema.nullable(),
    pending: z
      .strictObject({
        intentKey: cursorSchema,
        admitted: z.boolean(),
        mutationKey: cursorSchema.nullable(),
      })
      .nullable(),
  }),
  z.strictObject({ step: z.literal("physical") }),
  z.strictObject({ step: z.literal("cleanup"), afterMutationKey: cursorSchema.nullable() }),
  z.strictObject({ step: z.literal("complete") }),
]);
export type AccountErasurePhysicalStage = z.infer<typeof physicalStageSchema>;
export type AccountErasurePhysicalIntent = z.infer<typeof physicalIntentSchema>;
export type AccountErasurePhysicalPart = z.infer<typeof physicalPartSchema>;
export type AccountErasurePhysicalMutation = z.infer<typeof physicalMutationSchema>;
export type AccountErasurePhysicalProgress = z.infer<typeof physicalProgressSchema>;
export type PhysicalFamily = z.infer<typeof physicalFamilySchema>;
export type PhysicalValue =
  | AccountErasurePhysicalIntent
  | AccountErasurePhysicalPart
  | AccountErasurePhysicalMutation;
export type RetainedFamily = z.infer<typeof familySchema> | PhysicalFamily;
export interface PhysicalPage<T> {
  entries: Array<{ key: string; value: T }>;
  nextCursor: string | null;
}

export function isPhysicalFamily(family: RetainedFamily): family is PhysicalFamily {
  return (
    family === "physical_intent" || family === "physical_part" || family === "physical_mutation"
  );
}
export function parsePhysicalValue(family: PhysicalFamily, value: unknown): PhysicalValue {
  switch (family) {
    case "physical_intent":
      return physicalIntentSchema.parse(value);
    case "physical_part":
      return physicalPartSchema.parse(value);
    case "physical_mutation":
      return physicalMutationSchema.parse(value);
  }
}
export function physicalPhase(
  stage: AccountErasurePhysicalStage,
): "clickhouse_initial" | "clickhouse_verification" {
  return stage === "initial" ? "clickhouse_initial" : "clickhouse_verification";
}
export function physicalPlanSeal(stage: AccountErasurePhysicalStage): string {
  return `clickhouse_physical_plan_${stage}`;
}
