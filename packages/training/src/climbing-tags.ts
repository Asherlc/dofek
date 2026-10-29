import { z } from "zod";

const sourceText = z.string().refine((value) => value.trim().length > 0);

export const climbingTagSchema = z.strictObject({
  providerId: sourceText,
  sourceKey: sourceText,
  label: sourceText,
  categoryKey: sourceText.nullable(),
  categoryLabel: sourceText.nullable(),
});

export type ClimbingTag = z.infer<typeof climbingTagSchema>;
