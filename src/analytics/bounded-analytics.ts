import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import type { Database } from "../db/index.ts";
import type { AccountErasureSharedUserLocks } from "../jobs/account-erasure-work-guard.ts";
import { captureException } from "../lib/error-reporting.ts";
import { compileAnalyticsPageSql } from "./analytics-model-compiler.ts";
import { deriveAnalyticsPageScope } from "./analytics-page-scope.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "./analytics-query-owner.ts";
import {
  admitAnalyticsPage,
  assertAnalyticsPageAccountsActive,
  captureAnalyticsPage,
  checkpointAnalyticsPage,
  claimAnalyticsRunOwnership,
  completeAnalyticsEmptyPage,
  loadAnalyticsPageState,
  markAnalyticsPageOutputComplete,
} from "./analytics-work-store.ts";
import {
  analyticsEffectCursorSchema,
  analyticsStreamSchema,
  appendAnalyticsEffects,
  effectHash,
  readAnalyticsEffectPage,
  verifyAnalyticsEffectPage,
} from "./effect-journal.ts";

const pageDescriptorSchema = z.strictObject({
  runId: z.uuid(),
  stage: z.literal("scalar"),
  stream: analyticsStreamSchema,
  after: analyticsEffectCursorSchema.nullable(),
  pageSize: z.number().int().min(1).max(20),
});

class BoundedAnalyticsPageFailure extends Error {
  readonly state = "failed";
  readonly stage = "scalar";
  readonly runId: string;
  constructor(runId: string, cause: unknown) {
    super(
      `Scalar analytics page failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "BoundedAnalyticsPageFailure";
    this.runId = runId;
  }
}

/** One production scalar page; other stages are not admitted by this checkpoint. */
export async function runBoundedAnalyticsPage(
  clients: {
    database: Database;
    clickhouse: ClickHouseClient;
    guards: AccountErasureSharedUserLocks;
  },
  input: Omit<z.infer<typeof pageDescriptorSchema>, "after"> & { artifactDirectory: string },
): Promise<{ progressed: boolean; remaining: boolean }> {
  try {
    pageDescriptorSchema.parse({
      runId: input.runId,
      stage: input.stage,
      stream: input.stream,
      after: null,
      pageSize: input.pageSize,
    });
    const intentId = randomUUID();
    return await withAnalyticsQueryOwner(
      clients.database,
      clients.clickhouse,
      { resourceId: ANALYTICS_PUBLICATION_RESOURCE, intentId, releaseFailedPage: true },
      async (owner) => {
        const current = await loadAnalyticsPageState(clients.database, input);
        const ownerId = randomUUID();
        await claimAnalyticsRunOwnership(clients.database, {
          runId: input.runId,
          expectedOwnerId: current.ownerId,
          ownerId,
        });
        z.iso.datetime({ precision: 6 }).parse(owner.ingestedAt);
        const [whole, fraction] = owner.ingestedAt.split(".");
        if (!whole || !fraction)
          throw new Error("Exact persisted analytics publication timestamp is missing");
        const revision = (
          BigInt(Date.parse(`${whole}Z`)) * 1000n +
          BigInt(fraction.slice(0, 6))
        ).toString();
        const admitted = await admitAnalyticsPage(clients.database, {
          ...input,
          ownerId,
          publicationRevision: revision,
        });
        const descriptor = {
          runId: input.runId,
          stage: input.stage,
          stream: input.stream,
          after: admitted.after,
          pageSize: admitted.pageSize,
        };
        const page = await readAnalyticsEffectPage(
          { database: clients.database, clickhouse: owner.client },
          {
            ...descriptor,
            limit: admitted.pageSize,
          },
        );
        await captureAnalyticsPage(clients.database, {
          ...descriptor,
          ownerId,
          publicationRevision: admitted.publicationRevision,
          next: page.next,
          effectsDigest: createHash("sha256")
            .update(JSON.stringify(page.effects.map(effectHash)))
            .digest("hex"),
        });
        const scope = deriveAnalyticsPageScope({
          ...descriptor,
          publicationRevision: admitted.publicationRevision,
          page,
        });
        if (!scope) {
          await completeAnalyticsEmptyPage(clients.database, {
            ...input,
            ownerId,
            publicationRevision: admitted.publicationRevision,
          });
          return { progressed: false, remaining: !page.exhausted };
        }
        const downstream = page.effects.map((effect) => ({ ...effect, stage: "dedup" as const }));
        const accounts = [
          ...new Set(
            page.effects
              .flatMap((effect) => [effect.before?.userId, effect.after?.userId])
              .filter((id): id is string => id !== undefined)
              .map((id) => id.toLowerCase()),
          ),
        ].sort();
        return clients.guards.runWithSharedUserLocks(accounts, async () => {
          await owner.assertActive();
          await assertAnalyticsPageAccountsActive(clients.database, accounts);
          if (admitted.outputComplete) {
            await verifyAnalyticsEffectPage(owner.client, downstream);
            await owner.assertActive();
            await checkpointAnalyticsPage(clients.database, {
              ...descriptor,
              ownerId,
              expected: descriptor.after,
              next: scope.next,
              publicationRevision: admitted.publicationRevision,
            });
            return { progressed: true, remaining: !scope.exhausted };
          }
          if (JSON.stringify(current.cursor) !== JSON.stringify(descriptor.after))
            throw new Error("Scalar page cursor changed; replay cannot publish stale output");
          const compiled = await compileAnalyticsPageSql({
            stage: "scalar",
            vars: scope.vars,
            artifactDirectory: input.artifactDirectory,
          });
          await owner.assertActive();
          await owner.client.command({ query: `INSERT INTO ${compiled.relation} ${compiled.sql}` });
          await appendAnalyticsEffects(owner.client, downstream);
          await verifyAnalyticsEffectPage(owner.client, downstream);
          await owner.assertActive();
          await markAnalyticsPageOutputComplete(clients.database, {
            ...descriptor,
            ownerId,
            publicationRevision: admitted.publicationRevision,
          });
          await owner.assertActive();
          await checkpointAnalyticsPage(clients.database, {
            ...descriptor,
            ownerId,
            expected: descriptor.after,
            next: scope.next,
            publicationRevision: admitted.publicationRevision,
          });
          return { progressed: true, remaining: !scope.exhausted };
        });
      },
    );
  } catch (cause) {
    const error = new BoundedAnalyticsPageFailure(input.runId, cause);
    captureException(error, {
      tags: { source: "bounded-analytics", analyticsRunId: input.runId, analyticsStage: "scalar" },
    });
    throw error;
  }
}
