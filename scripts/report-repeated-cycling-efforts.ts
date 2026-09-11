import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ClickHouseActivitySensorStore } from "../packages/server/src/repositories/clickhouse-activity-sensor-store.ts";
import { CyclingPerformanceRepository } from "../packages/server/src/repositories/cycling-performance-repository.ts";
import { EffortTrendRepository } from "../packages/server/src/repositories/effort-trend-repository.ts";
import { PerformanceComparisonRepository } from "../packages/server/src/repositories/performance-comparison-repository.ts";
import {
  EFFORT_IDENTITY_KINDS,
  EQUIVALENCE_STRENGTHS,
} from "../packages/server/src/repositories/repeated-effort-types.ts";
import {
  type FindRepeatedEffortsOutput,
  RepeatedEffortsRepository,
} from "../packages/server/src/repositories/repeated-efforts-repository.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { userProfile } from "../src/db/schema/reference.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import { closeResources } from "./close-resources.ts";

type Group = FindRepeatedEffortsOutput["groups"][number];
type Comparison = Awaited<ReturnType<PerformanceComparisonRepository["compare"]>>;
const scopeSchema = z
  .object({
    userId: z.uuid(),
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    timezone: z
      .string()
      .refine(
        (value) => Intl.supportedValuesOf("timeZone").includes(value) || value === "UTC",
        "Use an IANA timezone",
      ),
  })
  .refine((scope) => scope.startDate <= scope.endDate, "--start must be on or before --end");
type Scope = z.infer<typeof scopeSchema>;

interface Report {
  scope: Scope;
  groups: Group[];
  assumptions: string[];
  comparisons: Array<{
    effortId: string;
    comparison: Comparison;
    trend: Awaited<ReturnType<EffortTrendRepository["get"]>>;
  }>;
  cycling: Awaited<ReturnType<CyclingPerformanceRepository["listRange"]>>;
}

const falseFitnessCaveat =
  "Ordinary workout bests are lower-bound observed capability, not maximal capacity. Lower observed power does not demonstrate fitness decline. Repeated identity does not establish maximal intent or comparable conditions.";
const routeKinds = new Set(["provider_route", "canonical_route", "climb", "segment"]);
const unique = (values: string[]) => [...new Set(values)].sort();
const multiYear = (group: Group) =>
  group.firstOccurrence.slice(0, 4) !== group.lastOccurrence.slice(0, 4);

function priority(group: Group): number {
  if (group.strength === "exact" && group.kind === "provider_workout") return 0;
  if (group.strength === "exact" && group.kind === "standardized_test") return 1;
  if (["exact", "strong_inferred"].includes(group.strength) && routeKinds.has(group.kind)) return 2;
  if (group.strength === "strong_inferred") return 3;
  if (group.strength === "caller_asserted") return 4;
  return 5;
}

function ordered(groups: Group[]): Group[] {
  return [...groups].sort(
    (left, right) =>
      priority(left) - priority(right) ||
      Number(multiYear(right)) - Number(multiYear(left)) ||
      right.repetitionCount - left.repetitionCount ||
      left.effortId.localeCompare(right.effortId),
  );
}

export function parseRepeatedCyclingReportOptions(args: string[]): Scope {
  const { values } = parseArgs({
    args,
    options: {
      "user-id": { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      timezone: { type: "string", default: "UTC" },
    },
    strict: true,
  });
  for (const key of ["user-id", "start", "end"] as const) {
    if (!values[key])
      throw new Error(`--${key} is required; use one explicitly authorized user and date range`);
  }
  return scopeSchema.parse({
    userId: values["user-id"],
    startDate: values.start,
    endDate: values.end,
    timezone: values.timezone,
  });
}

/** Uses the same user-bound services as MCP; no provider calls or metric calculations. */
export async function collectRepeatedCyclingReport(
  scope: Scope,
  services: {
    discovery: Pick<RepeatedEffortsRepository, "find">;
    comparison: Pick<PerformanceComparisonRepository, "compare">;
    cycling: Pick<CyclingPerformanceRepository, "listRange">;
  },
): Promise<Report> {
  scopeSchema.parse(scope);
  const groups: Group[] = [];
  const assumptions: string[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  do {
    const page = await services.discovery.find({
      startDate: scope.startDate,
      endDate: scope.endDate,
      canonicalTypes: ["cycling"],
      equivalenceStrength: "weak",
      minimumRepetitions: 2,
      limit: 100,
      cursor,
    });
    groups.push(...page.groups);
    assumptions.push(...page.assumptions);
    cursor = page.nextCursor;
    if (cursor) {
      if (seenCursors.has(cursor))
        throw new Error("Discovery returned a repeated cursor; report is incomplete");
      seenCursors.add(cursor);
    }
  } while (cursor);

  const comparisons: Report["comparisons"] = [];
  for (const group of ordered(groups).slice(0, 5)) {
    let comparison: Comparison | undefined;
    const trend = await new EffortTrendRepository(
      {
        async compare(input) {
          comparison = await services.comparison.compare(input);
          return comparison;
        },
      },
      {
        find: (input) => services.discovery.find({ ...input, canonicalTypes: ["cycling"] }),
      },
    ).get({ effortId: group.effortId, startDate: scope.startDate, endDate: scope.endDate });
    if (!comparison) throw new Error("Trend did not return its required comparison evidence");
    comparisons.push({ effortId: group.effortId, comparison, trend });
  }
  const cycling = await services.cycling.listRange(scope.startDate, scope.endDate);
  return { scope, groups, assumptions: unique(assumptions), comparisons, cycling };
}

/** Render server-computed metrics unchanged, with discovery counts kept distinct from ride counts. */
export function formatRepeatedCyclingReport(report: Report): string {
  const groups = ordered(report.groups);
  const exact = groups.filter(
    (group) =>
      group.strength === "exact" && group.identityEvidence.some((item) => item.provider !== null),
  );
  const routes = groups.filter(
    (group) => routeKinds.has(group.kind) && ["exact", "strong_inferred"].includes(group.strength),
  );
  const acrossYears = groups.filter(multiYear);
  const lines = [
    "Repeated cycling efforts — stored repository results",
    `Scope: ${JSON.stringify(report.scope)} (inclusive dates)`,
    falseFitnessCaveat,
    "Counts by equivalence kind / strength (groups and canonical repetition memberships; memberships overlap across identities, so do not sum as unique rides):",
  ];
  for (const kind of EFFORT_IDENTITY_KINDS) {
    for (const strength of EQUIVALENCE_STRENGTHS) {
      const matching = groups.filter((group) => group.kind === kind && group.strength === strength);
      lines.push(
        `${kind} / ${strength}: groups=${matching.length}, repetitions=${matching.reduce((total, group) => total + group.repetitionCount, 0)}`,
      );
    }
  }
  const list = (title: string, selected: Group[]) => {
    lines.push(`${title}: ${selected.length}`);
    for (const group of selected)
      lines.push(
        `${group.effortId} repetitions=${group.repetitionCount} first=${group.firstOccurrence} last=${group.lastOccurrence}`,
      );
  };
  list("Exact provider-defined repeats", exact);
  list("Repeated routes/climbs", routes);
  list(
    "Most frequent efforts (top 10)",
    [...groups]
      .sort((a, b) => b.repetitionCount - a.repetitionCount || a.effortId.localeCompare(b.effortId))
      .slice(0, 10),
  );
  list("Multi-year efforts", acrossYears);
  if (!groups.length)
    lines.push("No repeated groups observed; this does not prove no historical repeats exist.");

  lines.push(
    "Provider coverage (repeated-identity evidence and generic cycling source availability; not an upstream capability inventory):",
  );
  const providers = unique([
    ...groups.flatMap((group) => [
      ...group.providers,
      ...group.identityEvidence.flatMap((item) => (item.provider ? [item.provider] : [])),
    ]),
    ...Object.values(report.cycling.summary.power_availability_by_modality).flatMap(
      (row) => row.source_providers,
    ),
  ]);
  for (const provider of providers) {
    const kinds = unique(
      exact
        .filter((group) => group.identityEvidence.some((item) => item.provider === provider))
        .map((group) => group.kind),
    );
    lines.push(
      kinds.length
        ? `${provider}: observed exact kinds=${kinds.join(",")}`
        : `${provider}: no exact identity observed in repeated groups; support unknown`,
    );
  }
  if (!providers.length) lines.push("No provider evidence returned; exact support unknown.");

  lines.push(
    "Historical limitations:",
    "ClickHouse/dbt historical completeness and freshness are not certified by this report. Missing retained identities, unrefreshed models, or missing sensors can hide repeats; no provider network fetch or historical refresh is performed.",
    "Exact support requires retained reusable template/class/test/route/segment fields; activity instance IDs and names are not exact identities. See docs/activity-effort-identity-runbook.md for the v1 field map.",
    "Route inference requires usable geometry; partial/unavailable geometry cannot establish a high-confidence route. Direction, gaps, confidence, source devices and source providers remain in returned evidence.",
    "There is no separate structured-protocol discovery kind. Structured interval evidence is retained in selected comparisons when supplied; missing protocol identity is not inferred from power or duration.",
    "Caller-asserted benchmarks are not independently verified and are not included in default discovery. Weak names share type/modality and a five-minute duration bucket, not a proven protocol.",
    "Discovery fails above 2,000 canonical activities or 250 route candidates; narrow the range/filters rather than treat a truncated scan as complete. Trends include at most the first 100 chronological repetitions and preserve pagination and caveats.",
    "Multi-year means first and last observed repetition fall in different UTC calendar years; it does not assert observations in every intervening year.",
    "Compare maximal intent, interval execution, measurement source/device, sample coverage, FTP age, terrain, weather and pacing before interpreting deltas. Missing values remain null, not zero.",
    ...report.assumptions,
  );
  if (report.comparisons.filter((item) => item.trend.repetitions.length >= 2).length < 3) {
    lines.push(
      "Historical verification incomplete: fewer than three longitudinal examples with at least two returned repetitions.",
    );
  }
  lines.push("Discovery evidence (priority order; full quality and source provenance):");
  for (const group of groups) lines.push(JSON.stringify(group));
  lines.push(
    `Longitudinal comparisons: ${report.comparisons.length} (up to five, priority then multi-year/frequency)`,
  );
  for (const comparison of report.comparisons) lines.push(JSON.stringify(comparison));
  lines.push(
    "Generic observed power — descriptive evidence only; not an equivalent-effort comparison:",
    falseFitnessCaveat,
    "Repository rolling_90_day_best may include its lookback before the requested start; per-ride estimates are descriptive proxies, not verified FTP tests.",
    JSON.stringify(report.cycling),
  );
  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const scope = parseRepeatedCyclingReportOptions(process.argv.slice(2));
  // These credentials authenticate the operator; this CLI is not a public user-selectable endpoint.
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required; run through scripts/with-env.ts");
  if (!process.env.CLICKHOUSE_URL)
    throw new Error("CLICKHOUSE_URL is required; run through scripts/with-env.ts");
  const db = createDatabaseFromEnv();
  const clickhouse = createClickHouseClientFromEnv();
  try {
    const user = await db.query.userProfile.findFirst({
      columns: { id: true },
      where: eq(userProfile.id, scope.userId),
    });
    if (!user)
      throw new Error("--user-id does not identify a stored user in the configured database");
    const store = new ClickHouseActivitySensorStore(clickhouse);
    const report = await collectRepeatedCyclingReport(scope, {
      discovery: new RepeatedEffortsRepository(db, store, scope.userId, scope.timezone),
      comparison: new PerformanceComparisonRepository(db, store, scope.userId, scope.timezone),
      cycling: new CyclingPerformanceRepository(store, scope.userId, scope.timezone),
    });
    console.log(formatRepeatedCyclingReport(report));
  } finally {
    await closeResources([
      { name: "Postgres", close: () => db.$client.end() },
      { name: "ClickHouse", close: () => clickhouse.close?.() },
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (dsn) Sentry.init({ dsn, skipOpenTelemetrySetup: true });
  main().catch(async (error: unknown) => {
    captureException(error);
    const message = error instanceof Error ? error.message : "Unknown repository error";
    console.error(
      `[repeated-cycling-report] Historical verification blocked: ${message.replace(/\b(?:https?|postgres(?:ql)?):\/\/[^\s]+/g, "[connection URL redacted]")}`,
    );
    await Sentry.close(2_000);
    process.exitCode = 1;
  });
}
