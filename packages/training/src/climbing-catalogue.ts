import {
  catalogueSourceResultSchema,
  type catalogueTagSchema,
  catalogueSeedSchema as searchSeedSchema,
} from "@dofek/climbing-catalogue/contracts";
import { z } from "zod";

export const catalogueSeedSchema = searchSeedSchema.extend({
  userId: z.string().min(1),
  logEntryId: z.string().min(1),
});
export type CatalogueSeed = z.infer<typeof catalogueSeedSchema>;
export const climbingCatalogueContextSchema = z.strictObject({
  status: z.enum(["missing", "pending", "ready", "error"]),
  fetchedAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  error: z.string().nullable(),
  sources: z.array(catalogueSourceResultSchema),
});
export type ClimbingCatalogueContext = z.infer<typeof climbingCatalogueContextSchema>;

/** Present the server's match decision consistently on web and mobile. */
export function climbingCatalogueConfidenceLabel(
  confidence: ClimbingCatalogueContext["sources"][number]["matches"][number]["confidence"],
): string {
  const labels = {
    source: "Own source",
    reference: "Provider reference",
    corroborated: "Location corroborated",
    possible: "Possible match",
  };
  return labels[confidence];
}

/** Label literal catalogue tags without assigning unknown tags a wall or hold meaning. */
export function climbingCatalogueTagLabel(tag: z.infer<typeof catalogueTagSchema>): string {
  const prefix =
    tag.kind === "hold"
      ? "Holds"
      : tag.kind === "climb_type"
        ? "Climb type"
        : tag.kind === "steepness"
          ? "Wall"
          : tag.category && !/^\d+$/.test(tag.category)
            ? tag.category
            : "Tag";
  return `${prefix}: ${tag.label}${tag.scope === "inherited" ? ` (inherited${tag.inheritedFrom ? ` from ${tag.inheritedFrom}` : ""})` : ""}`;
}
