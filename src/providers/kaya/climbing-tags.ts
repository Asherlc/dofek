import type { ClimbingTag } from "@dofek/training/climbing-tags";
import { z } from "zod";

const sourceIdSchema = z
  .union([z.string().refine((value) => value.trim().length > 0), z.number().int()])
  .transform(String);
const tagSchema = z.object({
  id: sourceIdSchema,
  name: z.string().refine((value) => value.trim().length > 0),
  tag_type_id: sourceIdSchema.nullish(),
});
const sourceSchema = z.object({
  tags: z.array(z.unknown()).nullish(),
});
const ascentSchema = z.object({ climb: sourceSchema.nullish() });

// KAYA's source category IDs: https://set.plastick.rocks/index-11950.js.map
const categoryLabels: Record<string, string> = {
  "1": "Custom",
  "2": "Movement",
  "3": "Grip",
  "4": "Footwork",
  "5": "General",
  "6": "Style",
  "7": "Conditions",
  "8": "Start",
  "9": "Finish",
  "10": "Boldness",
};

export function decodeKayaClimbingTags(raw: unknown): ClimbingTag[] {
  const source = sourceSchema.safeParse(raw);
  const ascent = ascentSchema.safeParse(raw);
  const values =
    (ascent.success ? ascent.data.climb?.tags : undefined) ??
    (source.success ? source.data.tags : undefined) ??
    [];
  const tags = new Map<string, ClimbingTag>();
  for (const value of values) {
    const parsed = tagSchema.safeParse(value);
    if (!parsed.success) continue;
    const tag = parsed.data;
    const categoryKey = tag.tag_type_id ?? null;
    const key = JSON.stringify([categoryKey, tag.id]);
    if (!tags.has(key))
      tags.set(key, {
        providerId: "kaya",
        sourceKey: tag.id,
        label: tag.name,
        categoryKey,
        categoryLabel:
          categoryKey !== null && Object.hasOwn(categoryLabels, categoryKey)
            ? (categoryLabels[categoryKey] ?? null)
            : null,
      });
  }
  return [...tags.values()];
}
