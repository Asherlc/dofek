import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { runningRaceResult } from "../db/schema/activity.ts";
import { withSyncLog } from "../db/sync-log.ts";
import { loadTokens } from "../db/tokens.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { redactProviderServiceUnavailableError } from "../lib/provider-transport-error.ts";
import { fetchProviderPages } from "../sync/pagination.ts";
import { ProviderTokenRejectedError } from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { SyncProvider, SyncResult } from "./types.ts";

const apiBaseUrl = "https://runalyze.com/api/v1";
const pageSize = 100;
const raceSchema = z.object({
  activity_id: z.int().nullish(),
  date: z.union([z.literal(""), z.iso.datetime({ offset: true, local: true })]).optional(),
  name: z.string(),
  official_distance: z.number().nullable(),
  official_time: z.number().nullable(),
  status: z.enum(["completed", "dnf"]).optional(),
});
const racePageSchema = z.array(raceSchema);
const activityPageSchema = z.array(
  z.object({
    id: z.int().positive(),
    sport: z.object({ name: z.string().optional() }).nullish(),
    is_virtual: z.boolean().optional(),
  }),
);

async function getCollection<Result>(
  fetchCollection: typeof fetch,
  endpoint: string,
  query: Record<string, string>,
  token: string,
  schema: z.ZodType<Result>,
  signal?: AbortSignal,
): Promise<Result> {
  const url = new URL(`${apiBaseUrl}/${endpoint}`);
  url.search = new URLSearchParams(query).toString();
  const response = await fetchCollection(url, {
    headers: { token, Accept: "application/json" },
    redirect: "error",
    signal,
  });
  if (response.status === 401 || response.status === 403) {
    throw new ProviderTokenRejectedError(
      "Runalyze",
      "Create a new Personal API token in Runalyze and verify your Supporter or Premium access.",
    );
  }
  if (response.status !== 200) {
    throw new Error(`Runalyze ${endpoint} request failed (${response.status}).`);
  }
  const result = schema.safeParse(await response.json());
  if (!result.success) throw new Error(`Runalyze returned malformed ${endpoint} data.`);
  return result.data;
}

export class RunalyzeProvider implements SyncProvider {
  readonly id = "runalyze";
  readonly name = "Runalyze";

  validate(): null {
    return null;
  }

  authSetup() {
    return {
      apiBaseUrl,
      manualToken: {
        kind: "access-token" as const,
        label: "Personal API token",
        instructionsUrl: "https://runalyze.com/help/article/personal-api" as const,
        exchangeToken: async (token: string) => {
          await getCollection(
            createProviderRateLimitFetch(this.id),
            "raceresult",
            { page: "1", itemsPerPage: "1" },
            token,
            racePageSchema,
          ).catch((error: unknown) => {
            throw redactProviderServiceUnavailableError(error, "Runalyze token validation failed");
          });
          return {
            accessToken: token,
            refreshToken: null,
            expiresAt: new Date("2099-12-31T00:00:00.000Z"),
            scopes: "self",
          };
        },
      },
    };
  }

  async sync({ db, options: { userId, signal } }: SyncRun): Promise<SyncResult> {
    const started = Date.now();
    try {
      if (!userId) throw new Error("Runalyze sync requires an authenticated user ID.");
      const recordsSynced = await withSyncLog(
        db,
        this.id,
        "running_race_results",
        async () => {
          const tokens = await loadTokens(db, this.id, userId);
          if (!tokens) throw new Error("Connect Runalyze in Data Sources to sync race results.");
          const providerFetch = createProviderRateLimitFetch(this.id, globalThis.fetch, { userId });
          const races = new Map<
            number,
            Omit<typeof runningRaceResult.$inferInsert, "sourceSport">
          >();
          const inventory = await fetchProviderPages<z.infer<typeof raceSchema>, number>({
            providerId: this.id,
            stepName: "running_race_results",
            initialCursor: 1,
            fetchPage: async (cursor) => {
              const page = cursor ?? 1;
              const items = await getCollection(
                providerFetch,
                "raceresult",
                {
                  page: String(page),
                  itemsPerPage: String(pageSize),
                  "order[activity.time]": "asc",
                },
                tokens.accessToken,
                racePageSchema,
                signal,
              );
              if (items.length > pageSize)
                throw new Error("Runalyze returned an oversized race page.");
              return { items, nextCursor: items.length === pageSize ? page + 1 : null };
            },
          });
          if (!inventory.completed)
            throw new Error("Runalyze race inventory pagination was incomplete.");
          for (const race of inventory.items) {
            const { activity_id, date, official_distance, official_time } = race;
            if (
              race.status !== "completed" ||
              activity_id == null ||
              activity_id <= 0 ||
              !date ||
              official_distance == null ||
              official_distance <= 0 ||
              official_time == null ||
              official_time <= 0
            )
              continue;
            if (races.has(activity_id))
              throw new Error("Runalyze returned duplicate race activity IDs.");
            const distanceMeters = official_distance * 1000;
            if (!Number.isFinite(distanceMeters))
              throw new Error("Runalyze returned an invalid race distance.");
            races.set(activity_id, {
              userId,
              providerId: this.id,
              sourceActivityId: String(activity_id),
              sourceName: race.name || null,
              sourceDateTime: date,
              distanceMeters,
              finishSeconds: official_time,
            });
          }
          const activityIds = [...races.keys()];
          const resolved: (typeof runningRaceResult.$inferInsert)[] = [];
          for (let offset = 0; offset < activityIds.length; offset += pageSize) {
            const batch = activityIds.slice(offset, offset + pageSize);
            const unresolved = new Set(batch);
            const activities = await getCollection(
              providerFetch,
              "activity",
              {
                id: batch.join(","),
                page: "1",
                itemsPerPage: String(batch.length),
              },
              tokens.accessToken,
              activityPageSchema,
              signal,
            );
            for (const activity of activities) {
              if (!unresolved.delete(activity.id)) {
                throw new Error("Runalyze returned an unexpected linked activity.");
              }
              const race = races.get(activity.id);
              const sport = activity.sport?.name;
              if (race && sport?.toLowerCase() === "running" && activity.is_virtual === false) {
                resolved.push({ ...race, sourceSport: sport });
              }
            }
            if (unresolved.size > 0) {
              throw new Error("Runalyze omitted requested linked activities.");
            }
          }
          signal?.throwIfAborted();
          await db.transaction(async (transaction) => {
            await transaction
              .delete(runningRaceResult)
              .where(
                and(
                  eq(runningRaceResult.userId, userId),
                  eq(runningRaceResult.providerId, this.id),
                ),
              );
            for (let offset = 0; offset < resolved.length; offset += pageSize) {
              await transaction
                .insert(runningRaceResult)
                .values(resolved.slice(offset, offset + pageSize));
            }
          });
          return { recordCount: resolved.length, result: resolved.length };
        },
        userId,
      );
      return { provider: this.id, recordsSynced, errors: [], duration: Date.now() - started };
    } catch (error) {
      if (error instanceof ProviderRateLimitError) throw error;
      return {
        provider: this.id,
        recordsSynced: 0,
        duration: Date.now() - started,
        errors: [{ message: error instanceof Error ? error.message : String(error), cause: error }],
      };
    }
  }
}
