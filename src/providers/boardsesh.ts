import { isValidClimbingGrade } from "@dofek/training/climbing-grades";
import type { GradeComponent } from "@dofek/training/climbing-log";
import { z } from "zod";
import type {
  BoardLogbook,
  ClimbingBoardClient,
  StoredRawLoader,
} from "../lib/climbing-board-account.ts";
import { ClimbingBoardAccount } from "../lib/climbing-board-account.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { ProviderAuthError } from "./auth-errors.ts";
import type { ProviderAuthSetup, SyncProvider, SyncResult, SyncRun, TokenSet } from "./types.ts";

const batchSize = 10;

export interface ClimbLookupCandidate {
  /** Original source board type and problem ID; never rewritten. */
  sourceIdentity: string;
  boardName: string;
  layoutId: number;
  sizeId: number;
  setIds: readonly number[];
  angle: number;
  climbUuid: string;
}

export interface ResolveClimbIdentitiesInput {
  candidates: readonly ClimbLookupCandidate[];
  fetchFn: typeof fetch;
  accessToken: string;
  accountId: string;
  signal?: AbortSignal;
}

const responseSchema = z
  .object({
    data: z.record(z.string(), z.json()).nullable().optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();
const identitySchema = z.object({
  uuid: z.string().trim().min(1),
  boardType: z.string(),
  layoutId: z.number().int(),
});

function report(message: string) {
  captureException(new Error(message), {
    tags: { provider: "boardsesh", operation: "climb-identity" },
  });
}

function isAuthMessage(message: string) {
  return /authentication required|unauthorized|invalid token|token expired/i.test(message);
}

function signature(candidate: ClimbLookupCandidate) {
  return JSON.stringify([
    candidate.boardName,
    candidate.layoutId,
    candidate.sizeId,
    candidate.setIds,
    candidate.angle,
    candidate.climbUuid,
  ]);
}

/** One primary and one alternate candidate per source, in first-seen order. */
export function groupCandidates(candidates: readonly ClimbLookupCandidate[]) {
  const bySource = new Map<string, ClimbLookupCandidate[]>();
  for (const candidate of candidates) {
    const group = bySource.get(candidate.sourceIdentity) ?? [];
    if (!group.some((existing) => signature(existing) === signature(candidate)))
      group.push(candidate);
    bySource.set(candidate.sourceIdentity, group);
  }
  return bySource;
}

export function chunks<T>(items: readonly T[], size = batchSize): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    result.push([...items.slice(index, index + size)]);
  return result;
}

export function buildOperation(batch: readonly ClimbLookupCandidate[]) {
  const declarations = batch.map(
    (_, index) =>
      `$b${index}: String!, $l${index}: Int!, $s${index}: Int!, $t${index}: String!, $a${index}: Int!, $u${index}: ID!`,
  );
  const fields = batch.map(
    (_, index) =>
      `c${index}: climb(boardName: $b${index}, layoutId: $l${index}, sizeId: $s${index}, setIds: $t${index}, angle: $a${index}, climbUuid: $u${index}) { uuid boardType layoutId }`,
  );
  const variables: Record<string, unknown> = {};
  batch.forEach((candidate, index) => {
    Object.assign(variables, {
      [`b${index}`]: candidate.boardName,
      [`l${index}`]: candidate.layoutId,
      [`s${index}`]: candidate.sizeId,
      [`t${index}`]: candidate.setIds.join(","),
      [`a${index}`]: candidate.angle,
      [`u${index}`]: candidate.climbUuid,
    });
  });
  return {
    query: `query BoardSeshClimbLookup(${declarations.join(", ")}) { authenticatedUserId ${fields.join(" ")} }`,
    variables,
  };
}

async function runBatch(
  batch: readonly ClimbLookupCandidate[],
  input: ResolveClimbIdentitiesInput,
): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>(
    batch.map((candidate) => [candidate.sourceIdentity, null]),
  );
  const { query, variables } = buildOperation(batch);
  let response: Response;
  try {
    response = await input.fetchFn(graphqlUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${input.accessToken}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    report("BoardSesh identity lookup could not reach the service.");
    return results;
  }
  if ([401, 403].includes(response.status))
    throw new Error(
      "BoardSesh identity lookup authentication was rejected; reconnect before syncing.",
    );
  if (!response.ok) {
    report(`BoardSesh identity lookup failed (HTTP ${response.status}).`);
    return results;
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    report("BoardSesh returned an invalid identity response.");
    return results;
  }
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    report("BoardSesh returned an invalid identity response.");
    return results;
  }
  const messages = parsed.data.errors?.map(({ message }) => message) ?? [];
  if (messages.some(isAuthMessage))
    throw new Error(
      "BoardSesh identity lookup authentication was rejected; reconnect before syncing.",
    );
  if (messages.length) report(`BoardSesh identity lookup reported errors: ${messages.join("; ")}.`);

  const data = parsed.data.data;
  if (data) {
    const account = z
      .union([z.string(), z.number()])
      .transform(String)
      .safeParse(data.authenticatedUserId);
    if (!account.success || account.data !== input.accountId)
      throw new Error(
        "BoardSesh returned a different account than the connected account; reconnect before syncing.",
      );
    batch.forEach((candidate, index) => {
      const field = identitySchema.safeParse(data[`c${index}`]);
      if (!field.success) {
        report(`BoardSesh returned an invalid identity for ${candidate.sourceIdentity}.`);
        return;
      }
      if (
        field.data.boardType !== candidate.boardName ||
        field.data.layoutId !== candidate.layoutId
      ) {
        report(`BoardSesh returned a mismatched identity for ${candidate.sourceIdentity}.`);
        return;
      }
      results.set(candidate.sourceIdentity, field.data.uuid);
    });
  }
  return results;
}

/**
 * Optional, bounded identity enrichment. Non-authentication failures are
 * reported and leave identities unresolved so authoritative persistence can
 * continue; authentication, account mismatch and cancellation stay fatal.
 */
export async function resolveClimbIdentities(
  input: ResolveClimbIdentitiesInput,
): Promise<Map<string, string>> {
  const grouped = groupCandidates(input.candidates);
  const verified = new Map<string, string>();
  const primary = [...grouped.values()].flatMap((group) => group.slice(0, 1));
  const unresolved = new Set<string>();
  for (const batch of chunks(primary)) {
    for (const [source, uuid] of await runBatch(batch, input)) {
      if (uuid) verified.set(source, uuid);
      else unresolved.add(source);
    }
  }
  const alternates = [...unresolved].flatMap((source) => grouped.get(source)?.slice(1, 2) ?? []);
  for (const batch of chunks(alternates)) {
    for (const [source, uuid] of await runBatch(batch, input)) {
      if (uuid) {
        verified.set(source, uuid);
        unresolved.delete(source);
      }
    }
  }
  return verified;
}

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
const ascentIdentity = z.object({ boardType: z.string(), climbUuid: z.string() });
const storedAscent = z.object({
  metadata: z.object({ ascent: ascentIdentity.extend({ canonicalClimbUuid: identifier }) }),
});
const currentAscent = z.object({ metadata: z.object({ ascent: ascentIdentity }) });
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
const renderBoardSchema = z.object({
  layoutId: z.number().int(),
  sizeId: z.number().int(),
  setIds: z.array(z.number().int()),
});
const ascentMetadataSchema = z.object({
  uuid: identifier,
  climbUuid: identifier,
  boardType: identifier,
  isMirror: z.boolean(),
  angle: z.number().int(),
  climbName: z.string(),
  boardId: z.number().int().nullable(),
  boardDisplayName: z.string().nullable(),
  consensusDifficulty: z.number().nullable(),
  consensusDifficultyName: z.string().nullable(),
  boardseshDifficulty: z.number().nullable(),
  boardseshConfidence: z.string().nullable(),
  layoutId: z.number().int().nullable().optional(),
  renderBoard: renderBoardSchema.nullable().optional(),
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
    storedRaw?: StoredRawLoader,
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
    const candidates: ClimbLookupCandidate[] = [];
    const identityByEntry = new Map<BoardLogbook["entries"][number], string>();
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
          raw: z
            .json()
            .parse({ ...z.record(z.string(), z.json()).parse(raw), metadata: { grades } }),
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
          "query BoardSeshMetadata($userId: ID!, $input: AscentFeedInput!) { authenticatedUserId userAscentsFeed(userId: $userId, input: $input) { items { uuid climbUuid boardType isMirror angle climbName boardId boardDisplayName consensusDifficulty consensusDifficultyName boardseshDifficulty boardseshConfidence layoutId renderBoard { layoutId sizeId setIds } } hasMore } }",
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
              `${metadata.boardType}:${metadata.climbUuid}:${metadata.isMirror ? "mirror" : "normal"}` ||
            !entry.wallAngle ||
            !("value" in entry.wallAngle) ||
            entry.wallAngle.unit !== "degrees" ||
            entry.wallAngle.value !== metadata.angle
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
          const completedSend = entry.attempts.some(
            (attempt) =>
              attempt.sourceCompleted &&
              (attempt.sourceResult === "flash" || attempt.sourceResult === "send"),
          );
          const hasConsensus = metadata.consensusDifficulty != null;
          const renderBoard = metadata.renderBoard;
          const climbConfig =
            metadata.layoutId != null &&
            metadata.layoutId > 0 &&
            renderBoard != null &&
            renderBoard.layoutId === metadata.layoutId &&
            renderBoard.sizeId > 0
              ? {
                  layoutId: metadata.layoutId,
                  sizeId: renderBoard.sizeId,
                  setIds: renderBoard.setIds,
                }
              : null;
          const sourceIdentity = `${metadata.boardType}:${metadata.climbUuid}`;
          if (completedSend && hasConsensus && climbConfig) {
            identityByEntry.set(entry, sourceIdentity);
            candidates.push({
              sourceIdentity,
              boardName: metadata.boardType,
              layoutId: climbConfig.layoutId,
              sizeId: climbConfig.sizeId,
              setIds: climbConfig.setIds,
              angle: metadata.angle,
              climbUuid: metadata.climbUuid,
            });
          }
          entry.raw = z.json().parse({
            ...z.record(z.string(), z.json()).parse(entry.raw),
            metadata: {
              ...z
                .record(z.string(), z.json())
                .parse(z.record(z.string(), z.json()).parse(entry.raw).metadata ?? {}),
              ascent: metadata,
              board: board ?? null,
            },
          });
        }
        if (!page.hasMore) break;
        offset += page.items.length;
      }
    }
    const canonicalClimbIds = candidates.length
      ? await resolveClimbIdentities({
          candidates,
          fetchFn: this.#fetch,
          accessToken: current.accessToken,
          accountId: current.providerAccountId,
          signal,
        })
      : new Map<string, string>();
    // A temporarily unresolved lookup can succeed on a later tick in this sync;
    // attach the verified ID to every exactly matched tick after the feed is read.
    const attachCanonical = (
      entry: BoardLogbook["entries"][number],
      canonicalClimbUuid: string,
    ) => {
      const raw = z.record(z.string(), z.json()).parse(entry.raw);
      const metadata = z.record(z.string(), z.json()).parse(raw.metadata ?? {});
      const ascent = z.record(z.string(), z.json()).parse(metadata.ascent ?? {});
      entry.raw = z.json().parse({
        ...raw,
        metadata: { ...metadata, ascent: { ...ascent, canonicalClimbUuid } },
      });
    };
    const unresolved: BoardLogbook["entries"] = [];
    for (const [entry, sourceIdentity] of identityByEntry) {
      const canonicalClimbUuid = canonicalClimbIds.get(sourceIdentity);
      if (canonicalClimbUuid) attachCanonical(entry, canonicalClimbUuid);
      else unresolved.push(entry);
    }
    // A failed or empty lookup must not erase an ID verified by an earlier sync:
    // carry it forward only while the stored tick still names the same source climb.
    if (storedRaw && unresolved.length > 0) {
      const stored = await storedRaw(unresolved.map((entry) => entry.externalId));
      for (const entry of unresolved) {
        const previous = storedAscent.safeParse(stored.get(entry.externalId));
        const current = currentAscent.safeParse(entry.raw);
        if (
          previous.success &&
          current.success &&
          previous.data.metadata.ascent.boardType === current.data.metadata.ascent.boardType &&
          previous.data.metadata.ascent.climbUuid === current.data.metadata.ascent.climbUuid
        )
          attachCanonical(entry, previous.data.metadata.ascent.canonicalClimbUuid);
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
