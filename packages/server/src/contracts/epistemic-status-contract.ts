import { EPISTEMIC_STATUS } from "@dofek/scoring/epistemic-status";
import { z } from "zod";

export const epistemicStatusSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("observed"),
      label: z.literal(EPISTEMIC_STATUS.observed.label),
    })
    .strict(),
  z
    .object({
      kind: z.literal("estimated"),
      label: z.literal(EPISTEMIC_STATUS.estimated.label),
    })
    .strict(),
  z
    .object({
      kind: z.literal("associated"),
      label: z.literal(EPISTEMIC_STATUS.associated.label),
    })
    .strict(),
  z
    .object({
      kind: z.literal("suggested"),
      label: z.literal(EPISTEMIC_STATUS.suggested.label),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unavailable"),
      label: z.literal(EPISTEMIC_STATUS.unavailable.label),
    })
    .strict(),
]);

export type EpistemicStatus = z.infer<typeof epistemicStatusSchema>;
