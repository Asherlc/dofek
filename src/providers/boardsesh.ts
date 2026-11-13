import { isValidClimbingGrade } from "@dofek/training/climbing-grades";
import type { GradeComponent } from "@dofek/training/climbing-log";
import { z } from "zod";
import type { BoardLogbook, ClimbingBoardClient } from "../lib/climbing-board-account.ts";
import { ClimbingBoardAccount } from "../lib/climbing-board-account.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { ProviderAuthError } from "./auth-errors.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult, SyncRun, TokenSet } from "./types.ts";

const authUrl = "https://ws.boardsesh.com/auth/native/credentials";
const refreshUrl = "https://ws.boardsesh.com/auth/native/refresh";
const graphqlUrl = "https://ws.boardsesh.com/graphql";
const boardTypes = [
  "kilter",
  "tension",
  "moonboard",
  "decoy",
  "touchstone",
  "grasshopper",
  "soill",
  "woods",
  "spray",
] as const;
const identifier = z.string().trim().min(1);
const tokenResponseSchema = z.object({
  jwt: identifier,
  refreshToken: identifier,
  expiresAt: z.iso.datetime({ offset: true }),
});
const gradeSchema = z.object({ difficultyId: z.number().int(), name: identifier }).passthrough();
const tickSchema = z
  .object({
    uuid: identifier,
    userId: identifier,
    boardType: identifier,
    climbUuid: identifier,
    angle: z.number().int(),
    isMirror: z.boolean(),
    status: z.enum(["flash", "send", "attempt"]),
    attemptCount: z.number().int().positive(),
    quality: z.number().int().min(1).max(5).nullable(),
    difficulty: z.number().int().nullable(),
    comment: z.string(),
    climbedAt: z.string().min(1),
    boardId: z.number().int().nullable().optional(),
    layoutId: z.number().int().nullable().optional(),
  })
  .passthrough();
const ascentMetadataSchema = z.object({
  uuid: identifier,
  climbUuid: identifier,
  boardType: identifier,
  isMirror: z.boolean(),
  climbName: z.string(),
  boardId: z.number().int().nullable(),
  boardDisplayName: z.string().nullable(),
});
const boardIdentitySchema = z.object({ uuid: identifier, name: identifier, boardType: identifier });
const boardMetadataSchema = boardIdentitySchema.extend({
  locationName: z.string().nullable(),
  gymName: z.string().nullable(),
  latitude: z.number().min(-90).max(90).nullable(),
  longitude: z.number().min(-180).max(180).nullable(),
});
const graphQlSchema = z
  .object({
    data: z
      .object({ authenticatedUserId: z.union([z.string(), z.number()]).transform(String) })
      .passthrough()
      .nullable()
      .optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

function authError(message: string): ProviderAuthError {
  return new ProviderAuthError(
    "authentication_failed",
    `BoardSesh ${message}. Reconnect in Settings → Data Sources.`,
  );
}

async function readResponseJson(
  response: Response,
  operation: "login" | "refresh" | "GraphQL",
): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      const sanitized = new Error(`BoardSesh returned an invalid ${operation} response.`);
      captureException(sanitized, {
        tags: { provider: "boardsesh", operation },
      });
      throw sanitized;
    }
    throw error;
  }
}

function tokenSet(response: unknown, previous?: TokenSet): TokenSet {
  const result = tokenResponseSchema.safeParse(response);
  if (!result.success) throw new Error("BoardSesh returned an invalid token response.");
  const parsed = result.data;
  const expiresAt = new Date(parsed.expiresAt);
  if (expiresAt.getTime() <= Date.now())
    throw new Error("BoardSesh returned an expired token expiry.");
  return {
    accessToken: parsed.jwt,
    refreshToken: parsed.refreshToken,
    expiresAt,
    scopes: previous?.scopes ?? null,
    ...(previous?.providerAccountId ? { providerAccountId: previous.providerAccountId } : {}),
  };
}

function graphQlAuthFailure(messages: readonly string[]): boolean {
  return messages.every((message) =>
    /authentication required|unauthorized|invalid token|token expired/i.test(message),
  );
}

function recordedAt(value: string): string {
  const isoLike = value.includes("T") ? value : value.replace(" ", "T");
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoLike) ? isoLike : `${isoLike}Z`;
  const parsed = z.iso.datetime({ offset: true }).safeParse(normalized);
  if (!parsed.success) throw new Error("BoardSesh returned an invalid climbedAt timestamp.");
  return new Date(normalized).toISOString();
}

function gradeComponents(name: string | undefined): GradeComponent[] {
  if (!name) return [];
  const parts = name.split("/").map((part) => part.trim());
  if (parts.length > 2) return [];
  const systems = ["font", "v_scale"] as const;
  return parts.flatMap((value) => {
    const system = systems.find((candidate) => isValidClimbingGrade(value, candidate));
    return system ? [{ value, system }] : [];
  });
}

class BoardSeshClient implements ClimbingBoardClient {
  readonly #fetch: typeof fetch;
  constructor(fetchFn: typeof fetch) {
    this.#fetch = fetchFn;
  }

  async #graphql(
    tokens: TokenSet,
    query: string,
    variables: Record<string, unknown>,
    signal?: AbortSignal,
    verifyAccount = true,
  ) {
    const response = await this.#fetch(graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${tokens.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    if ([401, 403].includes(response.status)) return { authRejected: true as const };
    if (!response.ok)
      throw new Error(`BoardSesh GraphQL request failed (HTTP ${response.status}).`);
    const parsed = graphQlSchema.safeParse(await readResponseJson(response, "GraphQL"));
    if (!parsed.success) throw new Error("BoardSesh returned an invalid GraphQL response.");
    const result = parsed.data;
    const messages = result.errors?.map(({ message }) => message) ?? [];
    if (messages.length) {
      if (graphQlAuthFailure(messages)) return { authRejected: true as const };
      throw new Error("BoardSesh GraphQL request failed; no logbook records were reconciled.");
    }
    if (!result.data) throw new Error("BoardSesh GraphQL response did not contain data.");
    if (
      verifyAccount &&
      (!tokens.providerAccountId || result.data.authenticatedUserId !== tokens.providerAccountId)
    )
      throw new Error(
        "BoardSesh returned a different account than the connected account; reconnect before syncing.",
      );
    return { authRejected: false as const, data: result.data };
  }

  async login(email: string, password: string): Promise<TokenSet> {
    const response = await this.#fetch(authUrl, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if ([400, 401, 403].includes(response.status))
      throw authError("login failed; check your email and password");
    if (!response.ok) throw new Error(`BoardSesh login request failed (HTTP ${response.status}).`);
    const tokens = tokenSet(await readResponseJson(response, "login"));
    const result = await this.#graphql(
      tokens,
      "query { authenticatedUserId }",
      {},
      undefined,
      false,
    );
    if (result.authRejected) throw authError("login was rejected; check your email and password");
    const accountId = result.data.authenticatedUserId;
    if (!identifier.safeParse(accountId).success)
      throw new Error("BoardSesh returned an invalid account identity.");
    return { ...tokens, providerAccountId: accountId };
  }

  async fetchLogbook(
    tokens: TokenSet,
    persistTokens: (tokens: TokenSet) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<BoardLogbook> {
    let current = tokens;
    if (!current.providerAccountId) throw authError("connection has no verified account identity");
    let refreshed = false;
    const refresh = async () => {
      if (!current.refreshToken) throw authError("authorization expired; reconnect your account");
      const response = await this.#fetch(refreshUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken: current.refreshToken }),
        signal,
      });
      if ([400, 401, 403].includes(response.status))
        throw authError("refresh authorization expired or was revoked");
      if (!response.ok)
        throw new Error(`BoardSesh refresh request failed (HTTP ${response.status}).`);
      current = tokenSet(await readResponseJson(response, "refresh"), current);
      await persistTokens(current);
      refreshed = true;
    };
    if (current.expiresAt.getTime() <= Date.now()) await refresh();

    const request = async (query: string, variables: Record<string, unknown>) => {
      let result = await this.#graphql(current, query, variables, signal);
      if (result.authRejected && !refreshed) {
        await refresh();
        result = await this.#graphql(current, query, variables, signal);
      }
      if (result.authRejected)
        throw authError("authorization was rejected; reconnect your account");
      return result.data;
    };
    const entries: BoardLogbook["entries"] = [];
    const allIds = new Set<string>();
    for (const boardType of boardTypes) {
      const tickData = await request(
        "query BoardSeshTicks($input: GetTicksInput!) { authenticatedUserId ticks(input: $input) { uuid userId boardType climbUuid climbRevision angle isMirror status attemptCount quality difficulty isBenchmark comment climbedAt createdAt updatedAt sessionId auroraType auroraId auroraSyncedAt layoutId boardId boardDisplayName } }",
        { input: { boardType } },
      );
      const rawTicksResult = z.array(z.json()).safeParse(tickData.ticks);
      if (!rawTicksResult.success)
        throw new Error(
          "BoardSesh returned an invalid tick list; no logbook records were reconciled.",
        );
      const ticks = rawTicksResult.data.map((raw) => {
        const parsed = tickSchema.safeParse(raw);
        if (!parsed.success)
          throw new Error(
            "BoardSesh returned an invalid tick; no logbook records were reconciled.",
          );
        return { raw, tick: parsed.data };
      });
      const gradesData = await request(
        "query BoardSeshGrades($boardName: String!) { authenticatedUserId grades(boardName: $boardName) { difficultyId name } }",
        { boardName: boardType },
      );
      const gradesResult = z.array(gradeSchema).safeParse(gradesData.grades);
      if (!gradesResult.success)
        throw new Error(
          "BoardSesh returned an invalid grade list; no logbook records were reconciled.",
        );
      const grades = gradesResult.data;
      const gradesById = new Map(grades.map((grade) => [grade.difficultyId, grade.name]));
      for (const { raw, tick } of ticks) {
        if (tick.userId !== current.providerAccountId)
          throw new Error(
            "BoardSesh returned a tick owned by another account; no logbook records were reconciled.",
          );
        if (tick.boardType !== boardType)
          throw new Error(
            "BoardSesh returned a tick for a different board type; no logbook records were reconciled.",
          );
        if (allIds.has(tick.uuid))
          throw new Error(
            "BoardSesh returned duplicate tick identities; no logbook records were reconciled.",
          );
        allIds.add(tick.uuid);
        const statusCompleted = tick.status !== "attempt";
        entries.push({
          externalId: `boardsesh:tick:${tick.uuid}`,
          climbedOn: null,
          activityObservation: { recordedAt: recordedAt(tick.climbedAt) },
          discipline: "rock_climbing",
          sourceName: "BoardSesh",
          board: null,
          wallAngle: { value: tick.angle, unit: "degrees" },
          notes: tick.comment.trim() || null,
          reportedGrades: gradeComponents(
            tick.difficulty == null ? undefined : gradesById.get(tick.difficulty),
          ),
          reportedAttemptCounts: [{ scope: "climb", count: tick.attemptCount }],
          attempts: [
            {
              scope: "climb",
              sourceCompleted: statusCompleted,
              sourceResult: tick.status,
              attemptIndex: null,
              receivedBeta: null,
              fellOrHung: null,
              usedAid: null,
              dabbed: null,
              ...(tick.status === "flash" ? { qualifier: "free-flash" as const } : {}),
              ...(tick.status === "send" ? { qualifier: "free-send" as const } : {}),
            },
          ],
          climb: {
            externalId: `${tick.boardType}:${tick.climbUuid}:${tick.isMirror ? "mirror" : "normal"}`,
            kind: "boulder",
            setting: "indoor",
          },
          raw: z.record(z.string(), z.json()).parse(raw),
        });
      }
    }
    // The tick snapshot owns completeness. Display metadata may omit inaccessible climbs.
    if (entries.length) {
      const byId = new Map(entries.map((entry) => [entry.externalId, entry]));
      const boards = new Map<number, z.infer<typeof boardMetadataSchema> | null>();
      let offset = 0;
      while (true) {
        const data = await request(
          "query BoardSeshMetadata($userId: ID!, $input: AscentFeedInput!) { authenticatedUserId userAscentsFeed(userId: $userId, input: $input) { items { uuid climbUuid boardType isMirror climbName boardId boardDisplayName } hasMore } }",
          { userId: current.providerAccountId, input: { limit: 50, offset, statusMode: "both" } },
        );
        const page = z
          .object({ items: z.array(ascentMetadataSchema), hasMore: z.boolean() })
          .parse(data.userAscentsFeed);
        if (page.hasMore && page.items.length === 0)
          throw new Error(
            "BoardSesh metadata pagination did not advance; no logbook records were reconciled.",
          );
        for (const metadata of page.items) {
          const entry = byId.get(`boardsesh:tick:${metadata.uuid}`);
          if (!entry?.climb) continue;
          if (
            entry.climb.externalId !==
            `${metadata.boardType}:${metadata.climbUuid}:${metadata.isMirror ? "mirror" : "normal"}`
          )
            throw new Error(
              "BoardSesh metadata did not match its tick; no logbook records were reconciled.",
            );
          if (metadata.boardId !== null && !boards.has(metadata.boardId)) {
            const options = await request(
              "query BoardSeshTickBoard($tickUuid: ID!) { authenticatedUserId tickBoardOptions(tickUuid: $tickUuid, limit: 1) { currentBoard { uuid name boardType } } }",
              { tickUuid: metadata.uuid },
            );
            const { currentBoard } = z
              .object({ currentBoard: boardIdentitySchema.nullable() })
              .parse(options.tickBoardOptions);
            let board: z.infer<typeof boardMetadataSchema> | null = null;
            if (currentBoard) {
              const data = await request(
                "query BoardSeshBoard($boardUuid: ID!) { authenticatedUserId board(boardUuid: $boardUuid) { uuid name boardType locationName gymName latitude longitude } }",
                { boardUuid: currentBoard.uuid },
              );
              board = boardMetadataSchema.nullable().parse(data.board);
              if (
                currentBoard.boardType !== metadata.boardType ||
                (board &&
                  (board.uuid !== currentBoard.uuid || board.boardType !== metadata.boardType))
              )
                throw new Error(
                  "BoardSesh returned a different board for this tick; no logbook records were reconciled.",
                );
            }
            boards.set(metadata.boardId, board);
          }
          const board = metadata.boardId === null ? null : boards.get(metadata.boardId);
          const name = metadata.climbName.trim();
          entry.climb.name = name && name !== "Unknown Climb" ? name : null;
          const boardName = board?.name ?? metadata.boardDisplayName?.trim();
          entry.board = boardName ? { name: boardName, externalId: board?.uuid ?? null } : null;
          const coordinates =
            board && board.latitude !== null && board.longitude !== null
              ? { latitude: board.latitude, longitude: board.longitude }
              : null;
          const location =
            board?.locationName?.trim() ||
            board?.gymName?.trim() ||
            (coordinates ? board?.name : null);
          entry.areas =
            board && location
              ? [
                  {
                    externalId: `board:${board.uuid}`,
                    name: location,
                    coordinates,
                  },
                ]
              : [];
          entry.raw = z.json().parse({
            ...z.record(z.string(), z.json()).parse(entry.raw),
            metadata: { ascent: metadata, board: board ?? null },
          });
        }
        if (!page.hasMore) break;
        offset += page.items.length;
      }
    }
    return { entries, absentExternalIds: [], authoritative: true };
  }
}

export class BoardSeshProvider implements SyncProvider {
  readonly id = "boardsesh";
  readonly name = "BoardSesh";
  readonly #account: ClimbingBoardAccount;

  constructor(fetchFn: typeof fetch = globalThis.fetch) {
    this.#account = new ClimbingBoardAccount(
      this.id,
      this.name,
      "https://ws.boardsesh.com",
      new BoardSeshClient(createProviderRateLimitFetch(this.id, fetchFn)),
    );
  }

  validate(): string | null {
    return null;
  }
  authSetup(): ProviderAuthSetup {
    return this.#account.authSetup();
  }
  sync(run: SyncRun): Promise<SyncResult> {
    return this.#account.sync(run);
  }
}
