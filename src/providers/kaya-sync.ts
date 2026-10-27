import {
  localTimeContextUnknown,
  offsetMinutesFromTimestamp,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import {
  KayaApiError,
  type KayaAscent,
  KayaClient,
  KayaInvalidCredentialsError,
  type KayaSession,
  refreshKayaAccessToken,
  signInToKaya,
} from "@dofek/kaya-client";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { isValidClimbingGrade } from "@dofek/training/climbing-grades";
import { gpsCoordinatesSchema } from "@dofek/training/gps-coordinates";
import { sql } from "drizzle-orm";
import timezoneAt from "tz-lookup";
import { z } from "zod";
import { type ImageDiscovery, sourceImageIdentity } from "../activity-images/types.ts";
import { recordClimbingImageDiscovery } from "../db/activity-images.ts";
import { persistClimbingLogSnapshot } from "../db/climbing-log-snapshot.ts";
import type {
  SourceAreaDefinition,
  SourceClimbingAttempt,
  SourceClimbingLogEntry,
} from "../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../db/index.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../db/provider-activity-sync.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { executeWithSchema } from "../db/typed-sql.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  ProviderInvalidCredentialsError,
  ProviderStoredIdentityMissingError,
  RefreshTokenRevokedError,
} from "./auth-errors.ts";
import type { SyncRun } from "./sync-run.ts";
import type { ProviderAuthSetup, SyncError, SyncProvider, SyncResult, TokenSet } from "./types.ts";

const scopesSchema = z.object({ kayaUserId: z.string() });
const KAYA_ACCESS_TOKEN_REFRESH_INTERVAL_MS = 25 * 60_000;

export class KayaSyncProvider implements SyncProvider {
  readonly id = "kaya";
  readonly name = "Kaya";
  readonly fetchFn: typeof fetch;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    return null;
  }

  authSetup(): ProviderAuthSetup {
    return {
      apiBaseUrl: "https://kaya-beta.kayaclimb.com",
      automatedLogin: async (email, password) => {
        try {
          const tokens = await signInToKaya(email, password, this.fetchFn);
          return {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            expiresAt: new Date(Date.now() + KAYA_ACCESS_TOKEN_REFRESH_INTERVAL_MS),
            scopes: JSON.stringify({ kayaUserId: tokens.userId }),
          };
        } catch (error) {
          if (error instanceof KayaInvalidCredentialsError) {
            throw new ProviderInvalidCredentialsError(this.name, { cause: error });
          }
          throw error;
        }
      },
    };
  }

  async #refreshTokens(db: SyncDatabase, userId: string, tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refreshToken) throw new RefreshTokenRevokedError(this.name);
    try {
      const accessToken = await refreshKayaAccessToken(tokens.refreshToken, this.fetchFn);
      const refreshedTokens = {
        ...tokens,
        accessToken,
        expiresAt: new Date(Date.now() + KAYA_ACCESS_TOKEN_REFRESH_INTERVAL_MS),
      };
      await saveTokens(db, this.id, refreshedTokens, userId);
      return refreshedTokens;
    } catch (error) {
      if (error instanceof KayaApiError && error.status === 401) {
        throw new RefreshTokenRevokedError(this.name, { cause: error });
      }
      throw error;
    }
  }

  #isAccessTokenRejected(error: unknown): error is KayaApiError {
    return error instanceof KayaApiError && error.status === 401;
  }

  async discoverClimbingImages(
    run: SyncRun,
    externalId: string,
    _options?: { refresh?: boolean },
  ): Promise<ImageDiscovery> {
    const ascentId = /^kaya:ascent:([1-9]\d*)$/.exec(externalId)?.[1];
    if (!ascentId) throw new Error("Kaya photo refresh requires a valid ascent identity.");
    const userId = run.options.userId;
    if (!userId) throw new Error("Kaya photo refresh requires a userId.");
    try {
      let tokens = await loadTokens(run.db, this.id, userId);
      if (!tokens)
        throw new ProviderStoredIdentityMissingError(
          this.name,
          "credentials — reconnect via the app",
        );
      const identity = scopesSchema.parse(tokens.scopes ? JSON.parse(tokens.scopes) : null);
      if (tokens.expiresAt <= new Date())
        tokens = await this.#refreshTokens(run.db, userId, tokens);
      let ascents: KayaAscent[];
      try {
        ascents = await new KayaClient(tokens.accessToken, this.fetchFn).listAscents(
          identity.kayaUserId,
        );
      } catch (error) {
        if (!this.#isAccessTokenRejected(error)) throw error;
        tokens = await this.#refreshTokens(run.db, userId, tokens);
        ascents = await new KayaClient(tokens.accessToken, this.fetchFn).listAscents(
          identity.kayaUserId,
        );
      }
      const ascent = ascents.find((entry) => entry.id === ascentId);
      return ascent
        ? kayaImageDiscovery(ascent)
        : {
            coverage: "unavailable",
            expectedCount: null,
            reason: "kaya_ascent_not_found",
            images: [],
          };
    } catch (error) {
      if (!(error instanceof RefreshTokenRevokedError)) captureException(error);
      throw error;
    }
  }

  async sync(run: SyncRun): Promise<SyncResult> {
    const startedAt = Date.now();
    const userId = run.options.userId;
    if (!userId) throw new Error("kaya sync requires a userId");
    await ensureProvider(run.db, this.id, this.name, "https://kaya-beta.kayaclimb.com", userId);
    const tokens = await loadTokens(run.db, this.id, userId);
    if (!tokens) {
      return this.#result(startedAt, 0, [
        new ProviderStoredIdentityMissingError(this.name, "credentials — connect via the app"),
      ]);
    }
    const identity = scopesSchema.safeParse(tokens.scopes ? JSON.parse(tokens.scopes) : null);
    if (!identity.success) {
      return this.#result(startedAt, 0, [
        new ProviderStoredIdentityMissingError(
          this.name,
          "account identity — reconnect via the app",
        ),
      ]);
    }
    let activeTokens = tokens;
    if (tokens.expiresAt <= new Date()) {
      try {
        activeTokens = await this.#refreshTokens(run.db, userId, tokens);
      } catch (error) {
        if (!(error instanceof RefreshTokenRevokedError)) captureException(error);
        return this.#result(startedAt, 0, [error]);
      }
    }
    let client = new KayaClient(activeTokens.accessToken, this.fetchFn);
    let recordsSynced = 0;
    try {
      const database = run.db;
      let sessions: KayaSession[];
      let ascents: KayaAscent[];
      try {
        [sessions, ascents] = await Promise.all([
          client.listSessions(identity.data.kayaUserId),
          client.listAscents(identity.data.kayaUserId),
        ]);
      } catch (error) {
        if (!this.#isAccessTokenRejected(error)) throw error;
        activeTokens = await this.#refreshTokens(run.db, userId, activeTokens);
        client = new KayaClient(activeTokens.accessToken, this.fetchFn);
        [sessions, ascents] = await Promise.all([
          client.listSessions(identity.data.kayaUserId),
          client.listAscents(identity.data.kayaUserId),
        ]);
      }
      const ascentsBySession = new Map<string, typeof ascents>();
      for (const ascent of ascents) {
        if (!ascent.session_id) continue;
        const list = ascentsBySession.get(ascent.session_id) ?? [];
        list.push(ascent);
        ascentsBySession.set(ascent.session_id, list);
      }
      recordsSynced = await database.transaction(async (transaction) => {
        const entries: SourceClimbingLogEntry[] = [];
        const knownSessions = new Set(sessions.map((session) => session.id));
        for (const session of sessions) {
          const started = new Date(session.start_time);
          if (Number.isNaN(started.valueOf()))
            throw new Error(
              `Kaya session ${session.id} has an invalid start time. Try syncing again.`,
            );
          const parsedEnd = session.end_time ? new Date(session.end_time) : null;
          const ended =
            parsedEnd && !Number.isNaN(parsedEnd.valueOf()) && parsedEnd > started
              ? parsedEnd
              : null;
          const localTimeContext = kayaSessionLocalTimeContext(session, started, ended);
          const row = await upsertProviderActivity(
            transaction,
            {
              providerId: this.id,
              userId,
              externalId: session.id,
              activityType: resolveProviderActivityType("rock_climbing", "rock_climbing"),
              startedAt: started,
              endedAt: ended,
              name: session.gym ? `Kaya climbing at ${session.gym.name}` : "Kaya climbing",
              notes: session.notes ?? null,
              sourceName: this.name,
              timezone: localTimeContext.timezone,
              startUtcOffsetMinutes: localTimeContext.startUtcOffsetMinutes,
              endUtcOffsetMinutes: localTimeContext.endUtcOffsetMinutes,
              localTimeSource: localTimeContext.source,
              raw: session,
            },
            {
              activityType: resolveProviderActivityType("rock_climbing", "rock_climbing"),
              startedAt: started,
              endedAt: ended,
              name: session.gym ? `Kaya climbing at ${session.gym.name}` : "Kaya climbing",
              notes: session.notes ?? null,
              sourceName: this.name,
              timezone: localTimeContext.timezone,
              startUtcOffsetMinutes: localTimeContext.startUtcOffsetMinutes,
              endUtcOffsetMinutes: localTimeContext.endUtcOffsetMinutes,
              localTimeSource: localTimeContext.source,
              raw: session,
            },
          );
          if (!row)
            throw new Error(`Kaya session ${session.id} could not be saved. Try syncing again.`);
          const sessionAscents = ascentsBySession.get(session.id) ?? [];
          const sessionEntries = [
            ...sessionAscents.map((ascent) =>
              kayaLogEntry(ascent.climb, {
                externalId: `kaya:ascent:${ascent.id}`,
                date: ascent.date,
                label: ascent.ascent_type.name,
                attempts: ascent.attempts,
                gym: ascent.climb.gym ?? ascent.gym ?? session.gym,
                notes: ascent.comment,
                raw: ascent,
              }),
            ),
            ...session.attempted_climbs.map((record) => {
              const prefix = `${session.id}_`;
              const climbId = record.id.startsWith(prefix) ? record.id.slice(prefix.length) : "";
              if (!/^[1-9]\d*$/.test(climbId))
                throw new Error(
                  `Kaya attempted record ${record.id} has an ambiguous climb identity.`,
                );
              return kayaLogEntry(
                { ...record, id: climbId },
                {
                  externalId: `kaya:session:${session.id}:attempted:${record.id}`,
                  date: session.start_time,
                  attempts: record.attempts,
                  sent: record.sent,
                  gym: record.gym ?? session.gym,
                  raw: record,
                },
              );
            }),
          ];
          entries.push(...sessionEntries.map((entry) => ({ ...entry, activityId: row.id })));
        }
        const standaloneEntries = ascents
          .filter((ascent) => !ascent.session_id || !knownSessions.has(ascent.session_id))
          .map((ascent) =>
            kayaLogEntry(ascent.climb, {
              externalId: `kaya:ascent:${ascent.id}`,
              date: ascent.date,
              label: ascent.ascent_type.name,
              attempts: ascent.attempts,
              gym: ascent.climb.gym ?? ascent.gym ?? null,
              notes: ascent.comment,
              raw: ascent,
            }),
          );
        // Only replace an old source-owned link; user-selected outings remain attached.
        const sourceAttachedEntries =
          standaloneEntries.length === 0
            ? []
            : await executeWithSchema(
                transaction,
                z.object({ externalId: z.string() }),
                sql`
            SELECT entry.external_id AS "externalId"
            FROM fitness.climbing_log_entry AS entry
            JOIN fitness.activity AS attached ON attached.id = entry.activity_id
            WHERE entry.user_id = ${userId} AND entry.provider_id = ${this.id}
              AND attached.provider_id = ${this.id}
              AND attached.external_id = entry.raw ->> 'session_id'
              AND entry.external_id = ANY(${sql.param(standaloneEntries.map((entry) => entry.externalId))}::text[])
          `,
              );
        const sourceAttachedIds = new Set(sourceAttachedEntries.map((entry) => entry.externalId));
        const snapshotEntries = [
          ...entries,
          ...standaloneEntries.map((entry) =>
            sourceAttachedIds.has(entry.externalId) ? { ...entry, activityId: null } : entry,
          ),
        ];
        const result = await persistClimbingLogSnapshot(transaction, {
          userId,
          providerId: this.id,
          entries: snapshotEntries,
        });
        const ascentByExternalId = new Map(
          ascents.map((ascent) => [`kaya:ascent:${ascent.id}`, ascent]),
        );
        for (const [index, climbingLogEntryId] of result.logEntryIds.entries()) {
          const externalId = snapshotEntries[index]?.externalId;
          const ascent = externalId ? ascentByExternalId.get(externalId) : undefined;
          if (ascent)
            await recordClimbingImageDiscovery(transaction, {
              userId,
              climbingLogEntryId,
              providerId: this.id,
              discovery: kayaImageDiscovery(ascent),
            });
        }
        await finishProviderActivityListSync(transaction, {
          userId,
          providerId: this.id,
          windowStart: new Date(0),
          windowEnd: run.window.until,
          presentExternalIds: knownSessions,
          emptyListIsAuthoritative: true,
        });
        return result.recordsSynced;
      });
      return this.#result(startedAt, recordsSynced, []);
    } catch (error) {
      if (!(error instanceof RefreshTokenRevokedError)) captureException(error);
      return this.#result(startedAt, recordsSynced, [error]);
    }
  }

  #result(startedAt: number, recordsSynced: number, errors: unknown[]): SyncResult {
    return {
      provider: this.id,
      recordsSynced,
      errors: errors.map((error) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ) {
          const result: SyncError = { message: error.message };
          if ("externalId" in error && typeof error.externalId === "string") {
            result.externalId = error.externalId;
          }
          return result;
        }
        return { message: error instanceof Error ? error.message : String(error) };
      }),
      duration: Date.now() - startedAt,
    };
  }
}

function kayaLogEntry(
  climb: KayaAscent["climb"],
  source: {
    externalId: string;
    date: string;
    label?: string;
    attempts: number | null;
    sent?: boolean;
    gym: KayaAscent["climb"]["gym"];
    notes?: string | null;
    raw: SourceClimbingLogEntry["raw"];
  },
): SourceClimbingLogEntry {
  const boulder = climb.climb_type.name.toLowerCase().includes("boulder");
  const areas: SourceAreaDefinition[] = [];
  for (const location of [climb.destination, climb.area, climb.subarea]) {
    if (location) areas.push(kayaArea(location));
  }
  const setting = areas.length ? "outdoor" : source.gym ? "indoor" : null;
  if (!areas.length && source.gym) areas.push(kayaArea(source.gym));
  const climbedOn = source.date.trim() === "" ? null : source.date.slice(0, 10);
  if (
    climbedOn !== null &&
    (climbedOn.startsWith("0000-") || !z.iso.date().safeParse(climbedOn).success)
  )
    throw new Error(`Kaya log ${source.externalId} has an invalid climb date.`);
  const sourceResult =
    source.label ?? (source.sent === true ? "Send" : source.sent === false ? "Attempt" : undefined);
  const label = sourceResult?.trim().toLowerCase();
  const qualifier: SourceClimbingAttempt["qualifier"] =
    label === "onsight"
      ? "free-onsight"
      : label === "flash"
        ? "free-flash"
        : ["redpoint", "send", "repeat"].includes(label ?? "")
          ? "free-send"
          : undefined;
  const grade = climb.grade?.name.trim();
  const system = boulder ? "v_scale" : "yds";
  const ropeMethod = boulder || climb.lead == null ? null : climb.lead ? "lead" : "top_rope";
  const attempts: SourceClimbingAttempt[] = [
    {
      scope: "climb",
      ropeMethod,
      ...(qualifier === undefined ? {} : { qualifier }),
      ...(qualifier !== undefined || source.sent === false ? { sourceResult } : {}),
      ...(label === "repeat" ? { hadCompletedBefore: true } : {}),
    },
  ];
  if ((ropeMethod !== null || source.sent === false) && source.attempts !== null)
    for (let attemptCount = 1; attemptCount < source.attempts; attemptCount++)
      attempts.push({
        scope: "climb",
        ropeMethod,
        ...(source.sent === false ? { sourceResult: "Attempt" } : {}),
      });
  return {
    externalId: source.externalId,
    climbedOn,
    discipline: "rock_climbing",
    sourceName: "Kaya",
    ...(source.notes === undefined ? {} : { notes: source.notes }),
    raw: source.raw,
    board: climb.board ? { name: climb.board.name, externalId: climb.board.id } : null,
    wallAngle: climb.angle == null ? null : { value: climb.angle, unit: null },
    ...(source.attempts === null
      ? {}
      : { reportedAttemptCounts: [{ scope: "climb", count: source.attempts }] }),
    attempts,
    climb: {
      externalId: climb.id,
      name: climb.name,
      kind: boulder ? "boulder" : "route",
      setting,
      ...(grade === undefined
        ? {}
        : {
            publishedGrades: [
              { value: grade, system: isValidClimbingGrade(grade, system) ? system : null },
            ],
          }),
      ...(areas.length ? { areas } : {}),
    },
  };
}

function kayaArea(location: NonNullable<KayaAscent["climb"]["gym"]>): SourceAreaDefinition {
  return {
    name: location.name,
    externalId: location.id,
    ...(location.latitude == null || location.longitude == null
      ? {}
      : {
          coordinates: gpsCoordinatesSchema.parse({
            latitude: location.latitude,
            longitude: location.longitude,
          }),
        }),
  };
}

function kayaSessionLocalTimeContext(session: KayaSession, startedAt: Date, endedAt: Date | null) {
  const latitude = session.gym?.latitude;
  const longitude = session.gym?.longitude;
  if (
    latitude != null &&
    longitude != null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  ) {
    return resolveRecordLocalTimeContext({
      startedAt,
      endedAt,
      timezone: timezoneAt(latitude, longitude),
      source: "provider_timezone",
    });
  }

  const startUtcOffsetMinutes = offsetMinutesFromTimestamp(session.start_time);
  const endUtcOffsetMinutes =
    endedAt !== null && session.end_time ? offsetMinutesFromTimestamp(session.end_time) : null;
  if (
    startUtcOffsetMinutes == null ||
    startUtcOffsetMinutes === 0 ||
    (endedAt !== null && endUtcOffsetMinutes == null)
  ) {
    return localTimeContextUnknown();
  }
  return resolveRecordLocalTimeContext({
    startedAt,
    endedAt,
    startUtcOffsetMinutes,
    endUtcOffsetMinutes: endUtcOffsetMinutes === 0 ? null : endUtcOffsetMinutes,
    source: "provider_offset",
  });
}

const photoUrlSchema = z.url({ protocol: /^https$/ });
const mediaSchema = z
  .object({
    id: z.string().min(1),
    photo: z
      .object({
        photo_url: photoUrlSchema.nullish(),
        thumb_url: photoUrlSchema.nullish(),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

/** Only ascent photographs; climb galleries and video covers are separate source records. */
function kayaImageDiscovery(ascent: unknown): ImageDiscovery {
  const parsed = mediaSchema.safeParse(ascent);
  if (!parsed.success)
    return {
      coverage: "partial",
      expectedCount: null,
      reason: "invalid_kaya_ascent_photo",
      images: [],
    };
  const { id, photo } = parsed.data;
  if (photo === null) return { coverage: "complete", expectedCount: 0, reason: null, images: [] };
  const urls = [
    ...new Set(
      [photo.photo_url, photo.thumb_url].filter((url): url is string => typeof url === "string"),
    ),
  ];
  const first = urls[0];
  if (!first)
    return {
      coverage: "partial",
      expectedCount: null,
      reason: "invalid_kaya_ascent_photo",
      images: [],
    };
  return {
    coverage: "complete",
    expectedCount: 1,
    reason: null,
    images: [
      {
        sourceId: `kaya:ascent:${id}:photo`,
        kind: "photo",
        caption: null,
        position: 0,
        variants: urls.map((url) => ({ url, width: null, height: null })),
        revision: sourceImageIdentity(first),
        raw: { id, photo },
      },
    ],
  };
}
