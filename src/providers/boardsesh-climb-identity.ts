import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";

const graphqlUrl = "https://ws.boardsesh.com/graphql";
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
