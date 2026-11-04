import { z } from "zod";
import {
  type AnalyticsEffectPage,
  analyticsEffectCursorSchema,
  analyticsStreamSchema,
} from "./effect-journal.ts";
import type { AnalyticsEffectCursor, AnalyticsStream } from "./journal-position.ts";
import { assertPositionStream } from "./journal-position.ts";
import { sourcePlacementSchema } from "./source-placement.ts";

export const analyticsPageVarsSchema = z.strictObject({
  analytics_source_ids: z.array(z.uuid()).max(20),
  analytics_keys: z.array(sourcePlacementSchema.shape.key).max(40),
  analytics_publication_revision: z
    .string()
    .regex(/^[1-9]\d*$/)
    .pipe(
      z
        .string()
        .refine(
          (value) => BigInt(value) <= 18446744073709551615n,
          "Publication revision exceeds UInt64",
        ),
    ),
});

function coordinates(cursor: AnalyticsEffectCursor, stream: AnalyticsStream): bigint[] {
  analyticsEffectCursorSchema.parse(cursor);
  if (stream.transport === "kafka" && "offset" in cursor.delivery)
    return [BigInt(cursor.delivery.offset), BigInt(cursor.effectOrdinal)];
  if (stream.transport === "pulsar" && "major" in cursor.delivery)
    return [
      BigInt(cursor.delivery.major),
      BigInt(cursor.delivery.minor),
      BigInt(cursor.delivery.batch),
      BigInt(cursor.effectOrdinal),
    ];
  throw new Error("Analytics cursor transport must match its stream");
}

function compare(left: bigint[], right: bigint[]): number {
  for (const [index, value] of left.entries()) {
    const other = right[index];
    if (other === undefined) throw new Error("Analytics cursor coordinate mismatch");
    if (value !== other) return value < other ? -1 : 1;
  }
  return 0;
}

/** Consumes an authorized canonical reader result; this does not authorize a run. */
export function deriveAnalyticsPageScope(input: {
  runId: string;
  stage: "scalar" | "dedup";
  stream: AnalyticsStream;
  after: AnalyticsEffectCursor | null;
  publicationRevision: string | undefined;
  page: AnalyticsEffectPage;
}): {
  vars: z.infer<typeof analyticsPageVarsSchema>;
  next: AnalyticsEffectCursor;
  exhausted: boolean;
} | null {
  z.uuid().parse(input.runId);
  analyticsStreamSchema.parse(input.stream);
  z.enum(["scalar", "dedup"]).parse(input.stage);
  // Validate publication even on empty/no-advance pages so bad prerequisites never disappear.
  const vars = analyticsPageVarsSchema.parse({
    analytics_source_ids: [],
    analytics_keys: [],
    analytics_publication_revision: input.publicationRevision,
  });
  const after = input.after ? coordinates(input.after, input.stream) : null;
  const next = input.page.next;
  if (!next) {
    if (input.page.effects.length)
      throw new Error("Analytics effects require an advancing next cursor");
    return null;
  }
  const through = coordinates(next, input.stream);
  if (after && compare(through, after) <= 0) {
    if (compare(through, after) < 0 || input.page.effects.length)
      throw new Error("Analytics page next must advance its cursor");
    return null;
  }
  if (input.page.effects.length > 20) throw new Error("Analytics page exceeds twenty references");
  const ids = new Set<string>();
  const keys = new Map<string, z.infer<typeof sourcePlacementSchema.shape.key>>();
  for (const effect of input.page.effects) {
    if (effect.stage !== input.stage)
      throw new Error("Analytics effect stage differs from its captured page");
    assertPositionStream(effect.position, input.stream);
    const current = coordinates(effect.cursor, input.stream);
    if (compare(current, through) > 0 || (after && compare(current, after) <= 0))
      throw new Error("Analytics effect lies outside its captured interval");
    ids.add(effect.sourceId);
    for (const placement of [effect.before, effect.after]) {
      if (!placement) continue;
      const key = {
        ...placement.key,
        channel: placement.key.channel === "rr_interval_ms" ? "heart_rate" : placement.key.channel,
      };
      keys.set(JSON.stringify([key.userId, key.channel, key.recordedAt]), key);
    }
  }
  vars.analytics_source_ids = [...ids];
  vars.analytics_keys = [...keys.values()];
  return { vars: analyticsPageVarsSchema.parse(vars), next, exhausted: input.page.exhausted };
}
