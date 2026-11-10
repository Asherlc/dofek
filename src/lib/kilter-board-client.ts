import { isValidClimbingGrade } from "@dofek/training/climbing-grades";
import type { GradeComponent } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { TokenSet } from "../auth/oauth.ts";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../db/climbing-log-sync.ts";
import { ProviderAuthError } from "../providers/auth-errors.ts";
import type { BoardLogbook, ClimbingBoardClient } from "./climbing-board-account.ts";
import { KilterBoardDirectory } from "./kilter-board-directory.ts";

const baseUrl = "https://portal.kiltergrips.com";
const tokenUrl = "https://idp.kiltergrips.com/realms/kilter/protocol/openid-connect/token";
const id = z.string().trim().min(1);
const tokenSchema = z.object({
  access_token: id,
  refresh_token: id.optional(),
  expires_in: z.number().int().positive(),
  scope: z.string().optional(),
});
const gradeSchema = z
  .object({
    difficultyGradeId: z.number().int(),
    vScale: z.string().nullable().optional(),
    fontScale: z.string().nullable().optional(),
  })
  .passthrough();
const logSchema = z
  .object({
    logUuid: id,
    userUuid: id.optional(),
    climbUuid: id,
    climbName: z.string().nullable().optional(),
    createdAt: z.iso.datetime({ offset: true }),
    angle: z.number().min(-90).max(90).nullable().optional(),
    attempts: z.number().int().nonnegative().nullable().optional(),
    topped: z.boolean().nullable().optional(),
    flashed: z.boolean().nullable().optional(),
    currentDifficultyId: z.number().int().nullable().optional(),
    wallUuid: z.string().trim().nullable().optional(),
    gymUuid: z.string().trim().nullable().optional(),
    climbRating: z
      .object({
        angle: z.number(),
        difficultyGradeId: z.number().int().nullable().optional(),
        comment: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

function reconnect(message: string): ProviderAuthError {
  return new ProviderAuthError(
    "authentication_failed",
    `Kilter Board ${message}. Reconnect in Settings → Data Sources.`,
  );
}

function gradeComponents(grade: z.infer<typeof gradeSchema> | undefined): GradeComponent[] {
  const result: GradeComponent[] = [];
  for (const [value, system] of [
    [grade?.vScale, "v_scale"],
    [grade?.fontScale, "font"],
  ] as const) {
    if (value?.trim())
      result.push({ value, system: isValidClimbingGrade(value, system) ? system : null });
  }
  return result;
}

/** Current Kilter logbook protocol. Raw log occurrences are never grouped into sessions. */
export class KilterBoardClient implements ClimbingBoardClient {
  readonly #fetchFn: typeof fetch;
  readonly #directory: Pick<KilterBoardDirectory, "fetch">;
  constructor(
    fetchFn: typeof fetch = globalThis.fetch,
    directory: Pick<KilterBoardDirectory, "fetch"> = new KilterBoardDirectory(fetchFn),
  ) {
    this.#fetchFn = fetchFn;
    this.#directory = directory;
  }

  async #tokens(
    body: URLSearchParams,
    previous?: TokenSet,
    signal?: AbortSignal,
  ): Promise<TokenSet> {
    body.set("client_id", "kilter");
    const response = await this.#fetchFn(tokenUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });
    if ([400, 401, 403].includes(response.status))
      throw reconnect(
        previous
          ? "refresh authorization expired or was revoked"
          : "login failed; check your email and password",
      );
    if (!response.ok)
      throw new Error(`Kilter Board token request failed (HTTP ${response.status}).`);
    const parsed = tokenSchema.parse(await response.json());
    const refreshToken = parsed.refresh_token ?? previous?.refreshToken;
    if (!refreshToken) throw reconnect("did not issue a refreshable authorization");
    return {
      accessToken: parsed.access_token,
      refreshToken,
      expiresAt: new Date(Date.now() + parsed.expires_in * 1000),
      scopes: parsed.scope ?? previous?.scopes ?? null,
      ...(previous?.providerAccountId === undefined
        ? {}
        : { providerAccountId: previous.providerAccountId }),
    };
  }

  login(email: string, password: string): Promise<TokenSet> {
    return this.#tokens(
      new URLSearchParams({
        grant_type: "password",
        scope: "openid offline_access",
        username: email,
        password,
      }),
    );
  }

  async fetchLogbook(
    tokens: TokenSet,
    persistTokens: (tokens: TokenSet) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BoardLogbook> {
    let current = tokens;
    let refreshed = false;
    const refresh = async (refreshSignal = signal) => {
      if (!current.refreshToken) throw reconnect("requires a refreshable authorization");
      current = await this.#tokens(
        new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refreshToken }),
        current,
        refreshSignal,
      );
      // Commit a rotated credential before any further requests can fail.
      await persistTokens(current);
      refreshed = true;
    };
    if (current.expiresAt.getTime() <= Date.now()) {
      await refresh();
      refreshed = true;
    }
    const requestLogs = () =>
      this.#fetchFn(`${baseUrl}/api/logs`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${current.accessToken}` },
        signal,
      });
    let response = await requestLogs();
    if ([401, 403].includes(response.status) && !refreshed) {
      await refresh();
      response = await requestLogs();
    }
    if ([401, 403].includes(response.status))
      throw reconnect("authorization expired or was rejected");
    if (!response.ok)
      throw new Error(`Kilter Board logbook request failed (HTTP ${response.status}).`);
    const rawLogs = z.array(z.json()).parse(await response.json());
    const logs = rawLogs.map((raw) => ({ raw, log: logSchema.parse(raw) }));
    if (new Set(logs.map(({ log }) => log.logUuid)).size !== logs.length)
      throw new Error(
        "Kilter Board returned duplicate log identities; the logbook was not imported.",
      );
    const gradeResponse = await this.#fetchFn(`${baseUrl}/api/grades`, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!gradeResponse.ok)
      throw new Error(`Kilter Board grade request failed (HTTP ${gradeResponse.status}).`);
    const grades = z.array(gradeSchema).parse(await gradeResponse.json());
    const byId = new Map(grades.map((grade) => [grade.difficultyGradeId, grade]));
    let directory: Awaited<ReturnType<KilterBoardDirectory["fetch"]>> = { walls: [], gyms: [] };
    if (logs.some(({ log }) => log.wallUuid || log.gymUuid)) {
      for (const _attempt of [0, 1]) {
        try {
          directory = await this.#directory.fetch(async (directorySignal) => {
            if (current.expiresAt.getTime() <= Date.now()) await refresh(directorySignal);
            return { token: current.accessToken, expiresAt: current.expiresAt };
          }, signal);
          break;
        } catch (error) {
          const rejected =
            error instanceof Error &&
            "status" in error &&
            [401, 403].includes(Number(error.status));
          if (!rejected) throw error;
          if (refreshed) throw reconnect("directory authorization expired or was rejected");
          await refresh();
        }
      }
    }
    const walls = new Map(directory.walls.map((wall) => [wall.wall_uuid, wall]));
    const gyms = new Map(directory.gyms.map((gym) => [gym.gym_uuid, gym]));
    const entries: SourceClimbingLogEntry[] = logs.map(({ log, raw }) => {
      const wall = log.wallUuid ? walls.get(log.wallUuid) : undefined;
      if (log.gymUuid && wall?.gym_uuid && log.gymUuid !== wall.gym_uuid)
        throw new Error(
          `Kilter Board log ${log.logUuid} has conflicting gym identities. Check its board selection in Kilter and sync again.`,
        );
      const gymId = log.gymUuid || wall?.gym_uuid;
      const gym = gymId ? gyms.get(gymId) : undefined;
      const rating =
        log.angle != null && log.climbRating?.angle === log.angle ? log.climbRating : null;
      const difficulty = rating?.difficultyGradeId ?? log.currentDifficultyId;
      const completed = log.flashed === true ? true : log.topped;
      const attempt: SourceClimbingAttempt = {
        scope: "climb",
        ...(completed === undefined ? {} : { sourceCompleted: completed }),
      };
      return {
        externalId: `kilter:log:${log.logUuid}`,
        climbedOn: null,
        activityObservation: {
          recordedAt: log.createdAt,
          gymExternalId: log.gymUuid?.trim() || null,
        },
        discipline: "rock_climbing",
        sourceName: "Kilter Board",
        board: { name: wall?.name || "Kilter Board", externalId: log.wallUuid || null },
        areas: gym?.name
          ? [
              {
                externalId: gym.gym_uuid,
                name: gym.name,
                coordinates:
                  gym.latitude != null && gym.longitude != null
                    ? { latitude: gym.latitude, longitude: gym.longitude }
                    : null,
              },
            ]
          : [],
        ...(log.angle == null ? {} : { wallAngle: { value: log.angle, unit: "degrees" } }),
        notes: rating?.comment?.trim() ? rating.comment : null,
        reportedGrades: gradeComponents(difficulty == null ? undefined : byId.get(difficulty)),
        ...(log.attempts != null && log.attempts > 0
          ? { reportedAttemptCounts: [{ scope: "climb" as const, count: log.attempts }] }
          : {}),
        attempts: [attempt],
        climb: {
          externalId: log.climbUuid,
          kind: "boulder",
          setting: "indoor",
          ...(log.climbName?.trim() ? { name: log.climbName } : {}),
        },
        raw,
      };
    });
    return { entries, absentExternalIds: [], authoritative: true };
  }
}
