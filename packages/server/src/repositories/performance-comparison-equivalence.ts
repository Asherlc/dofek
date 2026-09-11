import {
  type ComparisonIdentityRow,
  type PerformanceComparisonIdentity,
  resolveExplicit,
  resolveFromReference,
} from "./performance-comparison-identity.ts";
import type {
  PerformanceEquivalence,
  ResolvedEquivalence,
} from "./performance-comparison-types.ts";

interface ReferenceActivity {
  activity_id: string;
  canonical_type: string;
  modality: string | null;
  member_activity_ids: string[];
  exercise_ids: string[];
  climb_identities: Parameters<typeof resolveFromReference>[0]["climb_identities"];
}

/** Resolve caller-supplied identity or derive the strongest defensible identity from a reference. */
export async function resolveComparisonEquivalence(input: {
  requested: PerformanceEquivalence | null;
  reference: ReferenceActivity | null;
  identities: PerformanceComparisonIdentity;
}): Promise<ResolvedEquivalence> {
  if (input.requested) return resolveExplicit(input.requested);
  if (!input.reference) throw new Error("A reference activity is required to derive equivalence");

  const rows = await input.identities.identities([input.reference]);
  const strongKey = input.identities.strongest(rows);
  if (strongKey) {
    return { ...resolveExplicit(strongKey), basis: "derived_from_reference" };
  }

  const routes =
    input.reference.canonical_type === "cycling"
      ? await input.identities.routes([input.reference])
      : [];
  if (
    routes.length > 0 &&
    (await input.identities.routeMatches(input.reference.activity_id, routes, [input.reference]))
      .length > 0
  ) {
    return {
      ...resolveExplicit({ kind: "canonical_route", value: input.reference.activity_id }),
      basis: "derived_from_reference",
    };
  }
  return resolveFromReference(input.reference);
}

/** Index authorized identity evidence once for candidate validation and result construction. */
export function indexComparisonIdentities(
  rows: ComparisonIdentityRow[],
): Map<string, ComparisonIdentityRow[]> {
  const indexed = new Map<string, ComparisonIdentityRow[]>();
  for (const row of rows) {
    indexed.set(row.canonical_activity_id, [
      ...(indexed.get(row.canonical_activity_id) ?? []),
      row,
    ]);
  }
  return indexed;
}
