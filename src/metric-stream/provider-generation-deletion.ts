import { createHash } from "node:crypto";
import { z } from "zod";
import { verifyAnalyticsDeliveryReceipt } from "../analytics/effect-journal.ts";
import { resolveSourcePlacements } from "../analytics/source-placement.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import {
  ACCOUNT_ERASURE_FENCE_TABLE,
  METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE,
  PROVIDER_DATA_GENERATION_TABLE,
} from "./clickhouse-table.ts";
import {
  type MetricStreamProviderGenerationDeletedEvent,
  metricStreamProviderGenerationDeletedEventSchema,
} from "./events.ts";
import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "./transport-position.ts";

export interface ProviderDeletionAcknowledgement {
  position: MetricStreamPosition;
  effectCount: bigint;
}

export interface ProviderDeletionSourceKey {
  generation: number;
  id: string;
}

type Reader = Pick<ClickHouseClient, "query">;
type Scope = Pick<
  MetricStreamProviderGenerationDeletedEvent,
  "userId" | "providerId" | "generation"
>;
const ackSchema = z.object({
  event_id: z.uuid(),
  command_id: z.uuid().nullable(),
  deletion_event_id: z.uuid().nullable(),
  user_id: z.uuid().nullable(),
  provider_id: z.string().nullable(),
  generation: z.string().nullable(),
  previous_command_id: z.uuid().nullable(),
  command_hash: z.string().length(64).nullable(),
  command_complete: z.number().int().min(0).max(1).nullable(),
  position: z.string().nullable(),
});
type Ack = z.infer<typeof ackSchema>;
const integerSettings = { output_format_json_quote_64bit_integers: 1 };

function commandHash(command: MetricStreamProviderGenerationDeletedEvent) {
  return createHash("sha256")
    .update(JSON.stringify(metricStreamProviderGenerationDeletedEventSchema.parse(command)))
    .digest("hex");
}
async function readAck(client: Reader, eventId: string): Promise<Ack | null> {
  const result = await client.query({
    query: `SELECT event_id,command_id,deletion_event_id,user_id,provider_id,generation,previous_command_id,
      command_hash,command_complete,position FROM ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE} FINAL WHERE event_id={eventId:UUID} LIMIT 2`,
    query_params: { eventId },
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  const rows = z.array(ackSchema).parse(await result.json());
  if (rows.length > 1)
    throw new Error(
      "Provider deletion acknowledgement identity is ambiguous; reconcile its canonical command receipt",
    );
  return rows[0] ?? null;
}
function assertIdentity(row: Ack, command: MetricStreamProviderGenerationDeletedEvent) {
  if (
    row.deletion_event_id !== command.deletionEventId ||
    row.user_id !== command.userId ||
    row.provider_id !== command.providerId ||
    row.generation !== String(command.generation) ||
    row.command_id === null ||
    row.command_hash === null ||
    row.command_complete === null ||
    row.position === null
  )
    throw new Error(
      "Provider deletion acknowledgement lacks matching typed operation identity; do not advance the cursor, reconcile its canonical command receipt",
    );
}
function positionOf(row: Ack) {
  if (row.position === null)
    throw new Error("Provider deletion acknowledgement has no actual delivery position");
  return metricStreamPositionSchema.parse(JSON.parse(row.position));
}

/** Exact content/identity and the original completed native delivery, never a maximum. */
async function readCommittedCommandAcknowledgement(
  client: Reader,
  command: MetricStreamProviderGenerationDeletedEvent,
): Promise<ProviderDeletionAcknowledgement | null> {
  metricStreamProviderGenerationDeletedEventSchema.parse(command);
  const row = await readAck(client, command.commandId);
  if (!row) return null;
  assertIdentity(row, command);
  if (
    row.command_id !== command.commandId ||
    row.command_hash !== commandHash(command) ||
    row.command_complete !== Number(command.complete) ||
    row.previous_command_id !== command.previousCommandId
  )
    throw new Error(
      "Provider deletion command identity or immutable page content changed; replay the original saved command",
    );
  const position = positionOf(row);
  const receipt = await verifyAnalyticsDeliveryReceipt(client, position);
  if (receipt.effectCount > BigInt(command.sourceIds.length))
    throw new Error("Provider deletion command receipt exceeds its structural page");
  return { position, effectCount: receipt.effectCount };
}

/** Completion requires the terminal command and the original deletion acknowledgement. */
export async function readProviderDeletionAcknowledgement(
  client: Reader,
  command: MetricStreamProviderGenerationDeletedEvent,
): Promise<ProviderDeletionAcknowledgement | null> {
  const committed = await readCommittedCommandAcknowledgement(client, command);
  if (!committed || !command.complete) return committed;
  const final = await readAck(client, command.deletionEventId);
  if (!final) return null;
  assertIdentity(final, command);
  if (
    final.command_id !== command.commandId ||
    final.command_hash !== commandHash(command) ||
    final.command_complete !== 1 ||
    final.previous_command_id !== command.previousCommandId ||
    compareMetricStreamPositions(positionOf(final), committed.position) !== 0
  )
    throw new Error("Provider deletion final acknowledgement does not match its terminal command");
  return committed;
}

export async function isProviderDeletionAccountErased(
  client: Reader,
  command: Scope,
): Promise<boolean> {
  const result = await client.query({
    query: `SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL WHERE user_hash={hash:String} LIMIT 1`,
    query_params: { hash: createHash("sha256").update(command.userId).digest("hex") },
    format: "JSONEachRow",
    clickhouse_settings: { log_queries: 0 },
  });
  return z.array(z.object({ user_hash: z.string() })).parse(await result.json()).length > 0;
}

async function assertFenceInstalled(client: Reader, command: Scope) {
  const result = await client.query({
    query: `SELECT toString(max(generation)) AS generation FROM ${PROVIDER_DATA_GENERATION_TABLE} WHERE user_id={user:UUID} AND provider_id={provider:String}`,
    query_params: { user: command.userId, provider: command.providerId },
    format: "JSONEachRow",
  });
  const installed = z
    .tuple([z.object({ generation: z.string().regex(/^\d+$/) })])
    .parse(await result.json())[0].generation;
  if (BigInt(installed) < BigInt(command.generation))
    throw new Error(
      "Provider generation fence was not installed; withhold command acknowledgement and keep the chain pending",
    );
}

export async function verifyProviderDeletionPredecessor(
  client: Reader,
  command: MetricStreamProviderGenerationDeletedEvent,
  position: MetricStreamPosition,
) {
  // A root/predecessor has only one canonical command ID. Its immutable ACK
  // binds the full body, so fork rejection needs no scan of unrelated history.
  metricStreamProviderGenerationDeletedEventSchema.parse(command);
  if (command.previousCommandId === null) return;
  const previous = await readAck(client, command.previousCommandId);
  if (!previous)
    throw new Error(
      "Provider deletion predecessor has no committed command acknowledgement; keep this command pending",
    );
  assertIdentity(previous, command);
  if (
    previous.event_id !== previous.command_id ||
    previous.command_id !== command.previousCommandId ||
    previous.command_complete !== 0
  )
    throw new Error("Provider deletion predecessor is not the expected nonterminal command");
  const previousPosition = positionOf(previous);
  if (compareMetricStreamPositions(previousPosition, position) >= 0)
    throw new Error(
      "Provider deletion command must follow its predecessor on the same physical stream and epoch",
    );
  await verifyAnalyticsDeliveryReceipt(client, previousPosition);
}

/** Protected structural bootstrap is a release prerequisite; empty is not readiness proof. */
export async function readProviderDeletionSourcePage(
  client: Reader,
  scope: Scope,
  after: ProviderDeletionSourceKey | null,
  limit: number,
): Promise<readonly ProviderDeletionSourceKey[]> {
  z.number().int().min(1).max(1000).parse(limit);
  const result = await client.query({
    query: `SELECT generation,source_id AS id FROM analytics.source_placement
      WHERE user_id={user:UUID} AND provider_id={provider:String} AND generation<{generation:UInt64} AND deleted=0
        ${after ? "AND (generation>{afterGeneration:UInt64} OR (generation={afterGeneration:UInt64} AND source_id>{afterId:UUID}))" : ""}
      GROUP BY generation,source_id ORDER BY generation,source_id LIMIT {limit:UInt32}`,
    query_params: {
      user: scope.userId,
      provider: scope.providerId,
      generation: scope.generation,
      afterGeneration: after?.generation,
      afterId: after?.id,
      limit,
    },
    format: "JSONEachRow",
    clickhouse_settings: integerSettings,
  });
  return z
    .array(
      z.object({
        generation: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        id: z.uuid(),
      }),
    )
    .max(limit)
    .parse(await result.json());
}

export async function assertNoProviderDeletionResiduals(client: Reader, command: Scope) {
  let after: ProviderDeletionSourceKey | null = null;
  for (;;) {
    const page = await readProviderDeletionSourcePage(client, command, after, 20);
    if (!page.length) return;
    const latest = await resolveSourcePlacements(client, [...new Set(page.map((key) => key.id))]);
    if (
      latest.some(
        (source) =>
          !source.deleted &&
          source.userId === command.userId &&
          source.providerId === command.providerId &&
          BigInt(source.generation) < BigInt(command.generation),
      )
    )
      throw new Error(
        "Provider deletion terminal command found live old-generation sources; keep completion pending and reconcile the missing structural page",
      );
    after = page.at(-1) ?? null;
  }
}

export async function advanceProviderDeletionFence(
  client: ClickHouseClient,
  command: MetricStreamProviderGenerationDeletedEvent,
  ingestedAt: string,
) {
  if (await isProviderDeletionAccountErased(client, command)) return;
  await client.command({
    query: `INSERT INTO ${PROVIDER_DATA_GENERATION_TABLE} (user_id,provider_id,generation,updated_at)
      SELECT {user:UUID},{provider:String},next_generation,parseDateTime64BestEffort({ingested:String},9)
      FROM (SELECT greatest({generation:UInt64},max(generation)) AS next_generation FROM ${PROVIDER_DATA_GENERATION_TABLE} WHERE user_id={user:UUID} AND provider_id={provider:String})
      WHERE lower(hex(SHA256(toString({user:UUID})))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)`,
    query_params: {
      user: command.userId,
      provider: command.providerId,
      generation: command.generation,
      ingested: ingestedAt,
    },
    clickhouse_settings: { log_queries: 0 },
  });
  if (!(await isProviderDeletionAccountErased(client, command)))
    await assertFenceInstalled(client, command);
}

async function writeAck(
  client: ClickHouseClient,
  command: MetricStreamProviderGenerationDeletedEvent,
  position: MetricStreamPosition,
  eventId: string,
) {
  await client.command({
    query: `INSERT INTO ${METRIC_STREAM_DELETE_ACKNOWLEDGEMENT_TABLE}
      (event_id,command_id,deletion_event_id,user_id,provider_id,generation,previous_command_id,command_hash,command_complete,position)
      SELECT {event:UUID},{command:UUID},{deletion:UUID},{user:UUID},{provider:String},{generation:UInt64},
        {previous:Nullable(UUID)},{hash:String},{complete:UInt8},{position:String}
      WHERE lower(hex(SHA256(toString({user:UUID})))) NOT IN (SELECT user_hash FROM ${ACCOUNT_ERASURE_FENCE_TABLE} FINAL)`,
    query_params: {
      event: eventId,
      command: command.commandId,
      deletion: command.deletionEventId,
      user: command.userId,
      provider: command.providerId,
      generation: command.generation,
      previous: command.previousCommandId,
      hash: commandHash(command),
      complete: Number(command.complete),
      position: JSON.stringify(position),
    },
    clickhouse_settings: { log_queries: 0 },
  });
}

/** Called only after this delivery's complete effect receipt; first ACK position is immutable. */
export async function acknowledgeProviderDeletionCommand(
  client: ClickHouseClient,
  command: MetricStreamProviderGenerationDeletedEvent,
  position: MetricStreamPosition,
) {
  if (await isProviderDeletionAccountErased(client, command)) return;
  const existing = await readCommittedCommandAcknowledgement(client, command);
  const canonicalPosition = existing?.position ?? position;
  await verifyProviderDeletionPredecessor(client, command, canonicalPosition);
  if (command.complete) await assertNoProviderDeletionResiduals(client, command);
  await assertFenceInstalled(client, command);
  await verifyAnalyticsDeliveryReceipt(client, position);
  if (!existing) await writeAck(client, command, position, command.commandId);
  if (await isProviderDeletionAccountErased(client, command)) return;
  if (!(await readCommittedCommandAcknowledgement(client, command)))
    throw new Error(
      "Provider deletion command acknowledgement was not published; retain pending evidence",
    );
  if (command.complete) {
    await writeAck(client, command, canonicalPosition, command.deletionEventId);
    if (!(await readProviderDeletionAcknowledgement(client, command)))
      throw new Error(
        "Provider deletion final acknowledgement was not published; retain pending command evidence",
      );
  }
}
