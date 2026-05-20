import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProviderModel } from "dofek/providers/provider-model";
import { getAllProviders } from "dofek/providers/registry";
import { getProviderSyncQueue, providerSyncQueueName, SYNC_JOB_RETRY_OPTIONS } from "dofek/jobs/queues";
import type { Database } from "dofek/db";
import { z } from "zod";
import { startWorker } from "../lib/start-worker.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { DailyMetricsRepository } from "../repositories/daily-metrics-repository.ts";
import { FoodRepository } from "../repositories/food-repository.ts";
import { SyncRepository } from "../repositories/sync-repository.ts";
import {
  CUSTOM_AUTH_PROVIDERS,
  ensureProvidersRegistered,
  isAuthError,
  resolveSinceIso,
  resolveTargetRefreshWindow,
  toJobId,
} from "../routers/sync-helpers.ts";
import { type McpScope, requireMcpScope } from "./token-repository.ts";

export interface DofekMcpContext {
  db: Pick<Database, "execute">;
  userId: string;
  scopes: McpScope[];
  timezone: string;
  sensorStore?: ActivitySensorStore;
}

function jsonContent(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function dateFromOptionalDateTime(value: string | undefined): string {
  return value ? new Date(value).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
}

export function createDofekMcpServer(context: DofekMcpContext): McpServer {
  const server = new McpServer({
    name: "dofek",
    version: "0.1.0",
  });

  server.registerTool(
    "get_daily_health_summary",
    {
      title: "Get Daily Health Summary",
      description: "Return server-computed health metrics for one day.",
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        timezone: z.string().optional(),
      },
    },
    async ({ date, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      const repository = new DailyMetricsRepository(
        context.db,
        context.userId,
        timezone ?? context.timezone,
      );
      const rows = await repository.list(1, date);
      return jsonContent(rows[0] ?? null);
    },
  );

  server.registerTool(
    "search_activities",
    {
      title: "Search Activities",
      description: "Search authenticated user activity summaries.",
      inputSchema: {
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        query: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(25).optional(),
      },
    },
    async ({ from, to, query, limit }) => {
      requireMcpScope(context.scopes, "activity:read");
      const endDate = to ?? new Date().toISOString();
      const days = from
        ? Math.max(
            1,
            Math.ceil((new Date(endDate).getTime() - new Date(from).getTime()) / 86_400_000),
          )
        : 30;
      const repository = new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      );
      const result = await repository.list({
        days,
        endDate,
        limit: limit ?? 10,
        offset: 0,
      });
      const loweredQuery = query?.toLowerCase();
      const items = loweredQuery
        ? result.items.filter((item) => {
            const searchable = `${String(item.name ?? "")} ${String(item.activity_type ?? "")}`;
            return searchable.toLowerCase().includes(loweredQuery);
          })
        : result.items;
      return jsonContent({ items, totalCount: result.totalCount });
    },
  );

  server.registerTool(
    "log_food",
    {
      title: "Log Food",
      description: "Create a Dofek food entry from a natural-language food description.",
      inputSchema: {
        text: z.string().min(1).max(500),
        occurredAt: z.string().datetime().optional(),
        mealType: z.enum(["breakfast", "lunch", "dinner", "snack", "other"]).optional(),
      },
    },
    async ({ text, occurredAt, mealType }) => {
      requireMcpScope(context.scopes, "nutrition:write");
      const repository = new FoodRepository(context.db, context.userId);
      const entry = await repository.quickAdd({
        date: dateFromOptionalDateTime(occurredAt),
        meal: mealType ?? "other",
        foodName: text,
      });
      return jsonContent(entry ?? null);
    },
  );

  server.registerTool(
    "list_providers",
    {
      title: "List Providers",
      description: "List configured user-facing providers and connection status.",
      inputSchema: {},
    },
    async () => {
      requireMcpScope(context.scopes, "providers:read");
      await ensureProvidersRegistered();
      const repository = new SyncRepository(context.db, context.userId);
      const [connectedProviders, lastSyncs, latestErrors] = await Promise.all([
        repository.getConnectedProviderIds(),
        repository.getLastSyncTimes(),
        repository.getLatestErrors(),
      ]);
      const connectedProviderIds = new Set(connectedProviders.map((provider) => provider.providerId));
      const lastSyncMap = new Map(lastSyncs.map((provider) => [provider.providerId, provider.lastSynced]));
      const authErrorProviderIds = new Set(
        latestErrors
          .filter((provider) => isAuthError(provider.errorMessage))
          .map((provider) => provider.providerId),
      );

      const providers = getAllProviders()
        .filter((provider) => provider.validate() === null)
        .map((provider) => {
          const model = new ProviderModel(
            provider,
            connectedProviderIds,
            lastSyncMap,
            CUSTOM_AUTH_PROVIDERS,
          );
          return {
            id: model.id,
            name: model.name,
            authType: model.authType,
            authorized: model.isConnected,
            lastSyncedAt: model.lastSyncedAt,
            importOnly: model.importOnly,
            needsReauth: model.isConnected && authErrorProviderIds.has(model.id),
          };
        });
      return jsonContent(providers);
    },
  );

  server.registerTool(
    "start_provider_sync",
    {
      title: "Start Provider Sync",
      description: "Enqueue a user-scoped provider sync job.",
      inputSchema: {
        providerId: z.string().min(1),
        sinceDays: z.number().int().positive().optional(),
      },
    },
    async ({ providerId, sinceDays }) => {
      requireMcpScope(context.scopes, "sync:write");
      await ensureProvidersRegistered();
      const provider = getAllProviders().find((candidate) => candidate.id === providerId);
      if (!provider) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      const validationMessage = provider.validate();
      if (validationMessage) {
        throw new Error(`Provider not configured: ${validationMessage}`);
      }
      const queue = getProviderSyncQueue(providerId);
      const job = await queue.add(
        "sync",
        {
          providerId,
          sinceDays,
          sinceIso: resolveSinceIso(sinceDays),
          targetRefreshWindow: resolveTargetRefreshWindow(sinceDays),
          userId: context.userId,
        },
        SYNC_JOB_RETRY_OPTIONS,
      );
      startWorker();
      return jsonContent({
        providerId,
        jobId: toJobId(job.id, providerId),
        queueName: providerSyncQueueName(providerId),
        status: "queued",
      });
    },
  );

  return server;
}
