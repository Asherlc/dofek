import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { executeWithSchema, type SqlExecutor, timestampStringSchema } from "../lib/typed-sql.ts";
import { repeatedEffortsResultSchema } from "../mcp/repeated-efforts-output.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import {
  EFFORT_IDENTITY_KINDS,
  type EffortIdentityKind,
  EQUIVALENCE_STRENGTHS,
  type EquivalenceStrength,
} from "./repeated-effort-types.ts";
import { evaluateRouteMatch } from "./route-equivalence.ts";

const inputSchema = z
  .object({
    startDate: dateSchema,
    endDate: dateSchema,
    minimumRepetitions: z.number().int().min(2).max(2000).default(2),
    equivalenceStrength: z.enum(["strong", "weak"]).default("strong"),
    effortKind: z.enum(EFFORT_IDENTITY_KINDS).optional(),
    providers: z.array(z.string().min(1)).max(50).default([]),
    modalities: z.array(z.string().min(1)).max(20).default([]),
    canonicalTypes: z.array(z.string().min(1)).max(50).default([]),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(4096).nullable().default(null),
  })
  .refine((input) => input.startDate <= input.endDate, "startDate must be on or before endDate");

export type FindRepeatedEffortsInput = z.input<typeof inputSchema>;
export type FindRepeatedEffortsOutput = z.infer<typeof repeatedEffortsResultSchema>;
type Group = FindRepeatedEffortsOutput["groups"][number];
const activitySchema = z.object({
  activity_id: z.uuid(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema.nullable(),
  canonical_type: z.string(),
  modality: z.string().nullable(),
  name: z.string().nullable(),
  member_activity_ids: z.array(z.uuid()),
  source_providers: z.array(z.string()),
});
type Activity = z.infer<typeof activitySchema>;
const identitySchema = z.object({
  canonical_activity_id: z.uuid(),
  source_activity_id: z.uuid(),
  source_provider: z.string(),
  source_external_id: z.string().nullable(),
  kind: z.enum(EFFORT_IDENTITY_KINDS),
  namespace: z.string().nullable(),
  value: z.string(),
  normalized_value: z.string(),
  display_name: z.string().nullable(),
  strength: z.enum(EQUIVALENCE_STRENGTHS),
  method: z.string(),
  source_field: z.string().nullable(),
  evidence: z.record(z.string(), z.unknown()),
});
type Identity = z.infer<typeof identitySchema>;
function identityEvidence(identity: Identity): Group["identityEvidence"][number] {
  return {
    canonicalActivityId: identity.canonical_activity_id,
    sourceActivityId: identity.source_activity_id,
    provider: identity.source_provider,
    externalId: identity.source_external_id,
    namespace: identity.namespace,
    value: identity.value,
    method: identity.method,
    sourceField: identity.source_field,
    evidence: identity.evidence,
  };
}
const sourceSchema = z.object({
  source_activity_id: z.uuid(),
  provider: z.string(),
  external_id: z.string().nullable(),
});
const routeSchema = z.object({
  canonical_activity_id: z.uuid(),
  points: z.array(z.tuple([z.number(), z.number()])).max(64),
  route_distance_meters: z.number().nullable(),
  elevation_profile: z.array(z.number()),
  coverage_pct: z.number().nullable(),
  largest_gap_seconds: z.number().nullable(),
  geometry_status: z.enum(["available", "partial", "unavailable"]),
  source_providers: z.array(z.string()),
  source_devices: z.array(z.string()),
});
type Route = z.infer<typeof routeSchema>;
const benchmarkSchema = z.object({
  group_id: z.uuid(),
  canonical_activity_id: z.uuid(),
  display_name: z.string(),
  notes: z.string().nullable(),
  inclusion_note: z.string().nullable(),
});
const cursorSchema = z.strictObject({
  version: z.literal(1),
  shape: z.string(),
  after: z.string(),
});
const nonMaximal =
  "Repeated efforts are not necessarily maximal tests; identity alone does not establish comparable performance or conditions.";
const unique = (values: string[]) => [...new Set(values)].sort();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function bounded<T>(rows: T[], maximum: number, kind: string): T[] {
  if (rows.length > maximum)
    throw new Error(
      `Repeated-effort discovery exceeds ${maximum} ${kind}; narrow the date range or filters.`,
    );
  return rows;
}
function geometry(route: Route) {
  return {
    points: route.points.map(([lat, lng]) => ({ lat, lng })),
    distance_meters: route.route_distance_meters,
    elevation_profile: route.elevation_profile,
    geometry_status: route.geometry_status,
    coverage_pct: route.coverage_pct,
    largest_gap_seconds: route.largest_gap_seconds,
  };
}

/** Bounded discovery over serving projections; never reads raw payloads or sensor streams. */
export class RepeatedEffortsRepository {
  readonly #db: SqlExecutor;
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  constructor(
    db: SqlExecutor,
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
  ) {
    this.#db = db;
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
  }

  async find(request: FindRepeatedEffortsInput): Promise<FindRepeatedEffortsOutput> {
    const input = inputSchema.parse(request);
    const shape = digest({
      userId: this.#userId,
      timezone: this.#timezone,
      ...input,
      providers: unique(input.providers),
      modalities: unique(input.modalities),
      canonicalTypes: unique(input.canonicalTypes),
      cursor: null,
      limit: null,
    });
    const cursor = input.cursor
      ? cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")))
      : null;
    if (cursor && cursor.shape !== shape)
      throw new Error("Repeated-effort cursor does not match this user or request.");
    const params = {
      userId: this.#userId,
      timezone: this.#timezone,
      startDate: input.startDate,
      endDate: input.endDate,
      providers: input.providers,
      modalities: input.modalities,
      canonicalTypes: input.canonicalTypes,
    };
    const rows = bounded(
      await this.#store.query(
        activitySchema,
        `SELECT activity_id,
      formatDateTime(a.started_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
      formatDateTime(a.ended_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS ended_at,
      canonical_type, modality, name, member_activity_ids, source_providers
      FROM analytics.deduped_activities AS a FINAL
      WHERE user_id = {userId:UUID} AND is_deleted = 0
        AND toDate(a.started_at, {timezone:String}) BETWEEN {startDate:Date} AND {endDate:Date}
        AND (a.ended_at IS NULL OR a.ended_at > a.started_at)
        AND (empty({providers:Array(String)}) OR hasAny(source_providers, {providers:Array(String)}))
        AND (empty({modalities:Array(String)}) OR has({modalities:Array(String)}, modality))
        AND (empty({canonicalTypes:Array(String)}) OR has({canonicalTypes:Array(String)}, canonical_type))
      ORDER BY activity_id LIMIT 2001`,
        params,
      ),
      2000,
      "canonical activities",
    );
    const activities = new Map(
      rows
        .filter(
          (row) =>
            Number.isFinite(Date.parse(row.started_at)) &&
            (row.ended_at === null || Date.parse(row.ended_at) > Date.parse(row.started_at)) &&
            (!input.providers.length ||
              row.source_providers.some((p) => input.providers.includes(p))) &&
            (!input.modalities.length || input.modalities.includes(row.modality ?? "")) &&
            (!input.canonicalTypes.length || input.canonicalTypes.includes(row.canonical_type)),
        )
        .map((row) => [row.activity_id, row]),
    );
    if (!activities.size) return { groups: [], nextCursor: null, assumptions: [nonMaximal] };
    const activityIds = [...activities.keys()];
    const memberIds = unique([...activities.values()].flatMap((a) => a.member_activity_ids));
    const queryParams = { ...params, activityIds, memberIds };
    const [identities, sources, routes, benchmarks] = await Promise.all([
      this.#store.query(
        identitySchema,
        `SELECT canonical_activity_id, source_activity_id, source_provider,
        source_external_id, kind, namespace, value, normalized_value, display_name, strength, method, source_field, evidence
        FROM analytics.activity_effort_identity FINAL
        WHERE user_id = {userId:UUID} AND is_deleted = 0
          AND canonical_activity_id IN {activityIds:Array(UUID)} LIMIT 20001`,
        queryParams,
      ),
      this.#store.query(
        sourceSchema,
        `SELECT activity_id AS source_activity_id, provider_id AS provider, external_id
        FROM analytics.activity_source_records FINAL
        WHERE user_id = {userId:UUID} AND is_deleted = 0 AND activity_id IN {memberIds:Array(UUID)} LIMIT 20001`,
        queryParams,
      ),
      !input.effortKind || input.effortKind === "canonical_route"
        ? this.#store.query(
            routeSchema,
            `SELECT canonical_activity_id,
        points, route_distance_meters, elevation_profile, coverage_pct, largest_gap_seconds, geometry_status,
        source_providers, source_devices
        FROM analytics.activity_route_identity FINAL
        WHERE user_id = {userId:UUID} AND is_deleted = 0
          AND canonical_activity_id IN {activityIds:Array(UUID)} ORDER BY canonical_activity_id LIMIT 251`,
            queryParams,
          )
        : Promise.resolve([]),
      input.effortKind === "user_defined_benchmark"
        ? executeWithSchema(
            this.#db,
            benchmarkSchema,
            sql`
        SELECT g.id AS group_id, m.canonical_activity_id, g.display_name, g.notes, m.inclusion_note
        FROM fitness.effort_equivalence_group g
        JOIN fitness.effort_equivalence_group_member m ON m.group_id = g.id AND m.user_id = g.user_id
        WHERE g.user_id = ${this.#userId} AND m.user_id = ${this.#userId}
          AND m.canonical_activity_id IN (${sql.join(
            activityIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})
        ORDER BY g.id, m.canonical_activity_id LIMIT 20001`,
          )
        : Promise.resolve([]),
    ]);
    bounded(identities, 20000, "identity rows");
    bounded(sources, 20000, "source rows");
    bounded(routes, 250, "route candidates");
    bounded(benchmarks, 20000, "benchmark memberships");
    const groups = new Map<string, Group>();
    const add = (
      kind: EffortIdentityKind,
      strength: EquivalenceStrength,
      key: unknown,
      activity: Activity,
      displayName: string | null,
      evidence: Group["identityEvidence"][number],
    ) => {
      const effortId = `${kind}:${strength}:${digest(key)}`;
      let group = groups.get(effortId);
      if (!group) {
        group = {
          effortId,
          kind,
          strength,
          displayName,
          providers: [],
          modalities: [],
          canonicalTypes: [],
          expectedDurationSeconds: null,
          repetitionCount: 0,
          firstOccurrence: activity.started_at,
          lastOccurrence: activity.started_at,
          canonicalActivityIds: [],
          memberActivityIds: [],
          sourceEvidence: [],
          identityEvidence: [],
          assumptions: [
            nonMaximal,
            "Expected protocol duration is unavailable in the identity projections; observed elapsed time is not a prescribed duration.",
          ],
          qualityFlags: ["expected_duration_unavailable"],
        };
        if (strength === "weak_similarity") {
          group.qualityFlags.push("weak_identity");
          group.assumptions.push(
            "Weak candidates share normalized name, activity type, modality and a five-minute elapsed-duration bucket; this does not prove identical workouts.",
          );
        }
        if (strength === "caller_asserted") {
          group.qualityFlags.push("caller_asserted_equivalence");
          group.assumptions.push(
            "Benchmark membership is a user assertion, not independently verified equivalence.",
          );
        }
        if (strength === "strong_inferred") {
          group.qualityFlags.push("geometry_inferred");
          group.assumptions.push(
            "Routes must match every member in the group using route_geometry_v1; direction and quality remain in the evidence. Geometry availability depends on the upstream route projection.",
          );
        }
        groups.set(effortId, group);
      }
      group.identityEvidence.push(evidence);
      if (group.canonicalActivityIds.includes(activity.activity_id)) return;
      group.canonicalActivityIds.push(activity.activity_id);
      group.memberActivityIds.push(...activity.member_activity_ids);
      group.providers.push(...activity.source_providers);
      if (activity.modality) group.modalities.push(activity.modality);
      group.canonicalTypes.push(activity.canonical_type);
      if (activity.member_activity_ids.length > 1) group.qualityFlags.push("merged_sources");
      group.sourceEvidence.push(
        ...sources
          .filter((s) => activity.member_activity_ids.includes(s.source_activity_id))
          .map((s) => ({
            canonicalActivityId: activity.activity_id,
            sourceActivityId: s.source_activity_id,
            provider: s.provider,
            externalId: s.external_id,
          })),
      );
      if (
        activity.member_activity_ids.some((id) => !sources.some((s) => s.source_activity_id === id))
      )
        group.qualityFlags.push("source_evidence_incomplete");
      group.firstOccurrence =
        group.firstOccurrence < activity.started_at ? group.firstOccurrence : activity.started_at;
      group.lastOccurrence =
        group.lastOccurrence > activity.started_at ? group.lastOccurrence : activity.started_at;
    };
    for (const identity of identities) {
      const activity = activities.get(identity.canonical_activity_id);
      if (
        !activity?.member_activity_ids.includes(identity.source_activity_id) ||
        !identity.value.trim() ||
        (input.effortKind && input.effortKind !== identity.kind)
      )
        continue;
      const weak = identity.kind === "activity_name" || identity.strength === "weak_similarity";
      if (weak && input.equivalenceStrength !== "weak") continue;
      if (!weak && !["exact", "strong_inferred"].includes(identity.strength)) continue;
      if (!weak && !identity.namespace) continue;
      const elapsed = activity.ended_at
        ? (Date.parse(activity.ended_at) - Date.parse(activity.started_at)) / 1000
        : null;
      if (weak && (elapsed === null || !identity.normalized_value.trim())) continue;
      add(
        identity.kind,
        weak ? "weak_similarity" : identity.strength,
        weak
          ? [
              identity.namespace,
              identity.normalized_value,
              activity.canonical_type,
              activity.modality,
              Math.floor((elapsed ?? 0) / 300),
            ]
          : [identity.namespace, identity.value],
        activity,
        identity.display_name,
        identityEvidence(identity),
      );
    }
    for (const benchmark of benchmarks) {
      const activity = activities.get(benchmark.canonical_activity_id);
      if (!activity) continue;
      add(
        "user_defined_benchmark",
        "caller_asserted",
        benchmark.group_id,
        activity,
        benchmark.display_name,
        {
          canonicalActivityId: activity.activity_id,
          sourceActivityId: null,
          provider: null,
          externalId: null,
          namespace: this.#userId,
          value: benchmark.group_id,
          method: "user_benchmark_membership",
          sourceField: null,
          evidence: { notes: benchmark.notes, inclusionNote: benchmark.inclusion_note },
        },
      );
    }
    const routeGroups: Route[][] = [];
    for (const route of routes) {
      if (!activities.has(route.canonical_activity_id) || route.geometry_status !== "available")
        continue;
      const matching = routeGroups.find((group) =>
        group.every((other) => {
          const left = activities.get(other.canonical_activity_id);
          const right = activities.get(route.canonical_activity_id);
          return (
            left?.canonical_type === right?.canonical_type &&
            left?.modality === right?.modality &&
            evaluateRouteMatch({ left: geometry(other), right: geometry(route) })?.matched === true
          );
        }),
      );
      if (matching) matching.push(route);
      else routeGroups.push([route]);
    }
    for (const routesInGroup of routeGroups) {
      const anchor = routesInGroup[0];
      if (!anchor || routesInGroup.length < 2) continue;
      for (const route of routesInGroup) {
        const activity = activities.get(route.canonical_activity_id);
        const match = evaluateRouteMatch({ left: geometry(anchor), right: geometry(route) });
        if (!activity || !match?.matched) continue;
        add(
          "canonical_route",
          "strong_inferred",
          [anchor.canonical_activity_id, anchor.points],
          activity,
          activity.name,
          {
            canonicalActivityId: activity.activity_id,
            sourceActivityId: null,
            provider: route.source_providers.length === 1 ? route.source_providers[0] : null,
            externalId: null,
            namespace: "route_geometry_v1",
            value: anchor.canonical_activity_id,
            method: "route_geometry_v1",
            sourceField: null,
            evidence: {
              ...match,
              anchorCanonicalActivityId: anchor.canonical_activity_id,
              anchorSourceProviders: anchor.source_providers,
              anchorSourceDevices: anchor.source_devices,
              sourceProviders: route.source_providers,
              sourceDevices: route.source_devices,
            },
          },
        );
      }
    }
    const eligible = [...groups.values()]
      .map((group) => ({
        ...group,
        repetitionCount: group.canonicalActivityIds.length,
        canonicalActivityIds: unique(group.canonicalActivityIds),
        memberActivityIds: unique(group.memberActivityIds),
        providers: unique(group.providers),
        modalities: unique(group.modalities),
        canonicalTypes: unique(group.canonicalTypes),
        qualityFlags: unique(group.qualityFlags),
        identityEvidence: [
          ...new Map(group.identityEvidence.map((e) => [JSON.stringify(e), e])).values(),
        ],
      }))
      .filter(
        (group) =>
          group.repetitionCount >= input.minimumRepetitions &&
          (!cursor || group.effortId > cursor.after),
      )
      .sort((a, b) => (a.effortId < b.effortId ? -1 : a.effortId > b.effortId ? 1 : 0));
    const page = eligible.slice(0, input.limit);
    const identitiesBySource = new Map<string, Identity[]>();
    for (const identity of identities) {
      if (
        !activities
          .get(identity.canonical_activity_id)
          ?.member_activity_ids.includes(identity.source_activity_id)
      )
        continue;
      const key = JSON.stringify([
        identity.canonical_activity_id,
        identity.kind,
        identity.namespace,
        identity.strength,
      ]);
      const entries = identitiesBySource.get(key) ?? [];
      entries.push(identity);
      identitiesBySource.set(key, entries);
    }
    for (const group of page) {
      const conflicts = group.identityEvidence.flatMap((evidence) => {
        const key = JSON.stringify([
          evidence.canonicalActivityId,
          group.kind,
          evidence.namespace,
          group.strength,
        ]);
        const entries = identitiesBySource.get(key) ?? [];
        return new Set(entries.map((entry) => entry.value)).size > 1
          ? entries.map(identityEvidence)
          : [];
      });
      if (conflicts.length) {
        group.qualityFlags.push("conflicting_identity_evidence");
        group.assumptions.push(
          "Some merged sources disagree on stable identity. Conflicting evidence is retained; review it before treating group members as comparable.",
        );
        group.identityEvidence = [
          ...new Map(
            [...group.identityEvidence, ...conflicts].map((evidence) => [
              JSON.stringify(evidence),
              evidence,
            ]),
          ).values(),
        ];
      }
    }
    const last = page.at(-1);
    return repeatedEffortsResultSchema.parse({
      groups: page,
      nextCursor:
        eligible.length > input.limit && last
          ? Buffer.from(JSON.stringify({ version: 1, shape, after: last.effortId })).toString(
              "base64url",
            )
          : null,
      assumptions: [
        nonMaximal,
        "Date filters use the analysis timezone. Discovery is bounded to 2,000 canonical activities, 250 routes and 20,000 evidence rows per projection; narrow the request if exceeded.",
        "Only explicitly selected user_defined_benchmark requests return caller assertions. Geometry group IDs are scoped to the selected candidate set and may change when that set changes.",
      ],
    });
  }
}
