import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import type { SourceClimbingLogEntry } from "../db/climbing-log-sync.ts";
import { ProviderAuthError } from "../providers/auth-errors.ts";
import type { BoardLogbook, ClimbingBoardClient } from "./climbing-board-account.ts";

const epoch = "1970-01-01 00:00:00.000000";
const jsonSchema = z.json();
const id = z.string().trim().min(1);
const ownerSchema = z.object({ uuid: id, user_id: z.number().int().positive() }).passthrough();
const recordSchema = ownerSchema.extend({
  climb_uuid: id,
  climbed_at: z.string(),
  angle: z.number().min(-90).max(90).nullable().optional(),
  wall_uuid: z.string().nullable().optional(),
  attempt_id: z.number().int().nullable().optional(),
  bid_count: z.number().int().nonnegative().nullable().optional(),
  comment: z.string().nullable().optional(),
});
const cursorSchema = z.object({
  table_name: id,
  last_synchronized_at: id,
  user_id: z.number().int().positive().optional(),
});
const pageSchema = z
  .object({
    _complete: z.boolean(),
    ascents: z.array(z.json()).optional(),
    bids: z.array(z.json()).optional(),
    attempts: z.array(z.object({ id: z.number().int(), name: id }).passthrough()).optional(),
    user_syncs: z.array(cursorSchema).optional(),
    shared_syncs: z.array(cursorSchema).optional(),
  })
  .passthrough();

function sourceDate(input: string): string {
  const normalized = input.includes("T") ? input : input.replace(" ", "T");
  const timestamp = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized) ? normalized : `${normalized}Z`;
  return new Date(z.iso.datetime({ offset: true }).parse(timestamp)).toISOString().slice(0, 10);
}

function isTombstone(value: unknown): boolean {
  return value === false || value === 0 || value === "0" || value === "false";
}

/** Shared Aurora protocol, composed by each independently registered board provider. */
export class AuroraBoardClient implements ClimbingBoardClient {
  readonly #providerId: string;
  readonly #name: string;
  readonly #baseUrl: string;
  readonly #fetchFn: typeof fetch;
  constructor(
    providerId: string,
    name: string,
    baseUrl: string,
    fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.#providerId = providerId;
    this.#name = name;
    this.#baseUrl = baseUrl;
    this.#fetchFn = fetchFn;
  }

  #headers(token?: string): Record<string, string> {
    return {
      Accept: "application/json",
      "User-Agent": "Kilter%20Board/202 CFNetwork/1568.100.1 Darwin/24.0.0",
      ...(token ? { Cookie: `token=${token}` } : {}),
    };
  }

  #reconnect(): ProviderAuthError {
    return new ProviderAuthError(
      "session_expired",
      `${this.#name} session expired or was rejected. Reconnect with your board username in Settings → Data Sources.`,
    );
  }

  async login(username: string, password: string): Promise<TokenSet> {
    const response = await this.#fetchFn(`${this.#baseUrl}/sessions`, {
      method: "POST",
      headers: { ...this.#headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, tou: "accepted", pp: "accepted", ua: "app" }),
    });
    if ([401, 403, 422].includes(response.status))
      throw new ProviderAuthError("authentication_failed", "Sign in failed");
    if (!response.ok) throw new Error(`${this.#name} login failed (HTTP ${response.status}).`);
    const data = z
      .object({ session: z.object({ token: id, user_id: z.number().int().positive() }) })
      .parse(await response.json());
    return {
      accessToken: data.session.token,
      refreshToken: null,
      // Required local storage marker for opaque sessions; Aurora advertises no expiry.
      expiresAt: new Date("2099-12-31T00:00:00.000Z"),
      scopes: null,
      providerAccountId: String(data.session.user_id),
    };
  }

  async fetchLogbook(
    tokens: TokenSet,
    _persistTokens: (tokens: TokenSet) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BoardLogbook> {
    if (!tokens.providerAccountId || !/^\d+$/.test(tokens.providerAccountId))
      throw this.#reconnect();
    const owner = Number(tokens.providerAccountId);
    const cursors = new Map(["ascents", "bids", "attempts"].map((table) => [table, epoch]));
    const records = new Map<
      string,
      { kind: "ascent" | "bid"; raw: z.infer<typeof jsonSchema>; absent: boolean }
    >();
    const resultNames = new Map<number, string>();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const response = await this.#fetchFn(`${this.#baseUrl}/sync`, {
        method: "POST",
        headers: {
          ...this.#headers(tokens.accessToken),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(Array.from(cursors)).toString(),
        signal,
      });
      if ([401, 403].includes(response.status)) throw this.#reconnect();
      if (!response.ok)
        throw new Error(`${this.#name} logbook request failed (HTTP ${response.status}).`);
      const page = pageSchema.parse(await response.json());
      for (const table of ["ascents", "bids"] as const) {
        for (const raw of page[table] ?? []) {
          const identity = ownerSchema.parse(raw);
          if (identity.user_id !== owner)
            throw new Error(
              `${this.#name} returned another account's logbook; reconnect your board account.`,
            );
          const kind = table === "ascents" ? "ascent" : "bid";
          const absent = kind === "ascent" && isTombstone(identity.is_listed);
          if (!absent) {
            const record = recordSchema.parse(raw);
            sourceDate(record.climbed_at);
          }
          records.set(`${this.#providerId}:${kind}:${identity.uuid}`, { kind, raw, absent });
        }
      }
      for (const attempt of page.attempts ?? []) resultNames.set(attempt.id, attempt.name);
      let advanced = false;
      for (const cursor of [...(page.user_syncs ?? []), ...(page.shared_syncs ?? [])]) {
        if (!cursors.has(cursor.table_name)) continue;
        if (cursor.user_id !== undefined && cursor.user_id !== owner)
          throw new Error(`${this.#name} returned a cursor for another account.`);
        if (cursor.last_synchronized_at > (cursors.get(cursor.table_name) ?? epoch)) {
          cursors.set(cursor.table_name, cursor.last_synchronized_at);
          advanced = true;
        }
      }
      if (page._complete) {
        const entries: SourceClimbingLogEntry[] = [];
        const absentExternalIds: string[] = [];
        for (const [externalId, record] of records) {
          if (record.absent) {
            absentExternalIds.push(externalId);
            continue;
          }
          const raw = recordSchema.parse(record.raw);
          const sourceResult = raw.attempt_id == null ? undefined : resultNames.get(raw.attempt_id);
          entries.push({
            externalId,
            climbedOn: sourceDate(raw.climbed_at),
            discipline: "rock_climbing",
            sourceName: this.#name,
            board: { name: this.#name, externalId: raw.wall_uuid || null },
            ...(raw.angle == null ? {} : { wallAngle: { value: raw.angle, unit: "degrees" } }),
            notes: raw.comment?.trim() ? raw.comment : null,
            reportedGrades: [],
            ...(record.kind === "bid" && raw.bid_count != null && raw.bid_count > 0
              ? { reportedAttemptCounts: [{ scope: "climb", count: raw.bid_count }] }
              : {}),
            attempts: [
              {
                scope: "climb",
                sourceCompleted: record.kind === "ascent",
                ...(sourceResult === undefined ? {} : { sourceResult }),
              },
            ],
            climb: { externalId: raw.climb_uuid, kind: "boulder", setting: "indoor" },
            raw: record.raw,
          });
        }
        return { entries, absentExternalIds, authoritative: false };
      }
      if (!advanced)
        throw new Error(
          `${this.#name} pagination did not advance; the incomplete logbook was not imported.`,
        );
    }
    throw new Error(
      `${this.#name} logbook exceeded 100 pages without completion; no data was imported.`,
    );
  }
}
