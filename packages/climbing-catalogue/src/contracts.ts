import { z } from "zod";
import { gpsCoordinatesSchema, numericWallAngleSchema } from "./geometry.ts";

export const catalogueProviderSchema = z.enum([
  "kaya",
  "mountain-project",
  "thecrag",
  "openbeta",
  "eight-a",
]);
const identityEvidence = {
  references: z
    .array(z.strictObject({ providerId: catalogueProviderSchema, externalId: z.string().min(1) }))
    .optional(),
  aliases: z.array(z.string().trim().min(1)).optional(),
};
export const catalogueTagSchema = z.strictObject({
  kind: z.enum(["steepness", "hold", "climb_type", "other"]),
  sourceKey: z.string(),
  label: z.string().min(1),
  category: z.string().nullable(),
  scope: z.enum(["direct", "inherited"]),
  inheritedFrom: z.string().nullable(),
});
export const catalogueAreaContextSchema = z.strictObject({
  url: z.url(),
  type: z.string().trim().min(1).nullable(),
  sections: z.array(
    z.strictObject({
      sourceKey: z.string().min(1),
      label: z.string().trim().min(1),
      text: z.string().trim().min(1),
      inheritedFrom: z.string().trim().min(1).nullable(),
    }),
  ),
  tags: z.array(catalogueTagSchema.extend({ count: z.number().int().nonnegative().nullable() })),
  statistics: z.array(
    z.strictObject({
      sourceKey: z.string().min(1),
      label: z.string().trim().min(1),
      value: z.number().finite(),
    }),
  ),
});
export const catalogueLocationSchema = z
  .strictObject({
    externalId: z.string().nullable(),
    name: z.string().nullable(),
    scope: z.enum(["climb", "area"]),
    coordinates: gpsCoordinatesSchema.nullable(),
    context: catalogueAreaContextSchema.optional(),
  })
  .refine((location) => location.scope === "area" || !location.context, {
    message: "Parent context belongs to an area, not a route point.",
  });
export const catalogueSeedSchema = z.strictObject({
  providerId: z.string().min(1),
  externalId: z.string().nullable(),
  sourceUrl: z.url().nullable(),
  name: z.string().trim().min(1).nullable(),
  kind: z.enum(["route", "boulder"]).nullable(),
  setting: z.enum(["indoor", "outdoor"]).nullable(),
  locations: z.array(catalogueLocationSchema),
  ...identityEvidence,
});
const origins = {
  kaya: "https://kaya-app.kayaclimb.com",
  "mountain-project": "https://www.mountainproject.com",
  thecrag: "https://www.thecrag.com",
  openbeta: "https://openbeta.io",
  "eight-a": "https://www.8a.nu",
};
export const catalogueCandidateSchema = z
  .strictObject({
    providerId: catalogueProviderSchema,
    externalId: z.string().min(1),
    url: z.url(),
    name: z.string().trim().min(1).nullable(),
    kind: z.enum(["route", "boulder"]).nullable(),
    setting: z.enum(["indoor", "outdoor"]).nullable(),
    locations: z.array(catalogueLocationSchema),
    grade: z.string().nullable(),
    angle: numericWallAngleSchema.nullable(),
    tags: z.array(catalogueTagSchema),
    ...identityEvidence,
  })
  .refine(
    (candidate) => {
      const url = new URL(candidate.url);
      return (
        url.origin === origins[candidate.providerId] &&
        !url.username &&
        !url.password &&
        candidate.locations.every((location) => {
          if (!location.context) return true;
          const area = new URL(location.context.url);
          return area.origin === origins[candidate.providerId] && !area.username && !area.password;
        })
      );
    },
    { message: "Catalogue source URL must belong to the recorded provider." },
  );
export const catalogueSearchResultSchema = z.strictObject({
  candidates: z.array(catalogueCandidateSchema),
  complete: z.boolean(),
  searchArea: catalogueLocationSchema.optional(),
});
export const catalogueSourceResultSchema = z
  .strictObject({
    providerId: catalogueProviderSchema,
    searchComplete: z.boolean(),
    searchArea: catalogueLocationSchema.optional(),
    matches: z.array(
      z.strictObject({
        confidence: z.enum(["source", "reference", "corroborated", "possible"]),
        candidate: catalogueCandidateSchema,
        evidence: z.array(z.string()).optional(),
      }),
    ),
  })
  .refine(
    (source) => source.matches.every((match) => match.candidate.providerId === source.providerId),
    {
      message: "Catalogue matches must belong to the recorded source provider.",
      path: ["matches"],
    },
  );
export type CatalogueProviderId = z.infer<typeof catalogueProviderSchema>;
export type CatalogueLocation = z.infer<typeof catalogueLocationSchema>;
export type CatalogueAreaContext = z.infer<typeof catalogueAreaContextSchema>;
export type CatalogueSeed = z.infer<typeof catalogueSeedSchema>;
export type CatalogueCandidate = z.infer<typeof catalogueCandidateSchema>;
export type CatalogueSearchResult = z.infer<typeof catalogueSearchResultSchema>;

export type CatalogueSourceResult = z.infer<typeof catalogueSourceResultSchema>;
export type CatalogueMatch = CatalogueSourceResult["matches"][number];
export interface ClimbingCatalogueAdapter {
  readonly providerId: CatalogueProviderId;
  search(seed: CatalogueSeed): Promise<CatalogueSearchResult>;
}
