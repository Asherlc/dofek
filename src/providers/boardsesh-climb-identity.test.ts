import { HttpResponse, http } from "msw";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import { createIntegrationMswFixture, startEarlyMsw } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import {
  buildOperation,
  type ClimbLookupCandidate,
  chunks,
  groupCandidates,
  resolveClimbIdentities,
} from "./boardsesh-climb-identity.ts";

vi.mock("../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const server = createIntegrationMswFixture();
const candidate = (
  index: number,
  overrides: Partial<ClimbLookupCandidate> = {},
): ClimbLookupCandidate => ({
  sourceIdentity: `kilter:climb-${index}`,
  boardName: "kilter",
  layoutId: 11,
  sizeId: 3,
  setIds: [1, 2, 3],
  angle: 40,
  climbUuid: `climb-${index}`,
  ...overrides,
});

function useLookup(
  resolve: (index: number, variables: Record<string, unknown>) => unknown,
  options: { status?: number; errors?: Array<{ message: string }>; accountId?: string } = {},
) {
  const operations: Array<{ query: string; variables: Record<string, unknown> }> = [];
  server.use(
    http.post("https://ws.boardsesh.com/graphql", async ({ request }) => {
      const body = z
        .object({ query: z.string(), variables: z.record(z.string(), z.unknown()) })
        .parse(await request.json());
      operations.push(body);
      if (options.status) return new HttpResponse(null, { status: options.status });
      const data: Record<string, unknown> = {
        authenticatedUserId: options.accountId ?? "owner-1",
      };
      for (const match of body.query.matchAll(/\bc(\d+): climb\(/g)) {
        const index = Number(match[1]);
        data[`c${index}`] = resolve(index, body.variables);
      }
      return HttpResponse.json({ data, ...(options.errors ? { errors: options.errors } : {}) });
    }),
  );
  return operations;
}

const input = (
  candidates: ClimbLookupCandidate[],
  overrides: Partial<Parameters<typeof resolveClimbIdentities>[0]> = {},
) => ({
  candidates,
  fetchFn: globalThis.fetch,
  accessToken: "access",
  accountId: "owner-1",
  ...overrides,
});

let stop: () => void;
beforeAll(() => {
  stop = startEarlyMsw();
  server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
});
afterAll(() => {
  server.deactivate();
  stop();
});
beforeEach(() => {
  vi.clearAllMocks();
  server.resetHandlers();
});

describe("BoardSesh climb identity lookup", () => {
  it("groups exact eligible inputs and bounds each variable-bound operation to ten sources", () => {
    const grouped = groupCandidates([
      candidate(1),
      candidate(1),
      candidate(1, { angle: 45 }),
      candidate(2),
    ]);
    expect(grouped.get("kilter:climb-1")).toHaveLength(2);
    expect(grouped.get("kilter:climb-2")).toHaveLength(1);
    expect(chunks([...grouped.keys()], 10).map((batch) => batch.length)).toEqual([2]);
    expect(
      chunks(Array.from({ length: 11 }, (_, index) => index)).map((batch) => batch.length),
    ).toEqual([10, 1]);

    const { query, variables } = buildOperation([candidate(3, { setIds: [7, 9] })]);
    expect(query).toContain("BoardSeshClimbLookup");
    expect(query).toContain("c0: climb(boardName: $b0");
    expect(query).toContain("authenticatedUserId");
    expect(variables).toEqual({
      b0: "kilter",
      l0: 11,
      s0: 3,
      t0: "7,9",
      a0: 40,
      u0: "climb-3",
    });
  });

  it("resolves every verified alias across batches while keeping original source IDs in requests", async () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(index));
    const operations = useLookup((index, variables) => ({
      uuid: `canonical-${variables[`u${index}`]}`,
      boardType: "kilter",
      layoutId: 11,
    }));

    const result = await resolveClimbIdentities(input(candidates));

    expect(operations).toHaveLength(2);
    expect(operations[0]?.variables.u9).toBe("climb-9");
    expect(operations[1]?.variables.u0).toBe("climb-10");
    expect(operations[1]?.variables.u1).toBe("climb-11");
    expect(result.size).toBe(12);
    expect(result.get("kilter:climb-0")).toBe("canonical-climb-0");
    expect(result.get("kilter:climb-11")).toBe("canonical-climb-11");
  });

  it("reports a partial response error but keeps verified aliases", async () => {
    const operations = useLookup(
      (index) => (index === 0 ? { uuid: "canonical-0", boardType: "kilter", layoutId: 11 } : null),
      { errors: [{ message: "one climb field failed" }] },
    );

    const result = await resolveClimbIdentities(input([candidate(0), candidate(1)]));

    expect(operations).toHaveLength(1);
    expect(result.get("kilter:climb-0")).toBe("canonical-0");
    expect(result.has("kilter:climb-1")).toBe(false);
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("one climb field failed") }),
      expect.objectContaining({ tags: { provider: "boardsesh", operation: "climb-identity" } }),
    );
  });

  it("reports an API failure and leaves the identity unresolved without throwing", async () => {
    useLookup(() => null, { status: 500 });

    const result = await resolveClimbIdentities(input([candidate(0)]));

    expect(result.size).toBe(0);
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("uses an eligible alternate candidate when the first lookup is null", async () => {
    const candidates = [candidate(0, { angle: 40 }), candidate(0, { angle: 45 })];
    const operations = useLookup((_, variables) =>
      variables.a0 === 40 ? null : { uuid: "canonical-0", boardType: "kilter", layoutId: 11 },
    );

    const result = await resolveClimbIdentities(input(candidates));

    expect(operations).toHaveLength(2);
    expect(result.get("kilter:climb-0")).toBe("canonical-0");
  });

  it("does not attach an identity whose board type or layout does not match", async () => {
    useLookup(() => ({ uuid: "canonical-0", boardType: "tension", layoutId: 11 }));
    expect((await resolveClimbIdentities(input([candidate(0)]))).size).toBe(0);
    expect(captureException).toHaveBeenCalledOnce();

    server.resetHandlers();
    useLookup(() => ({ uuid: "canonical-0", boardType: "kilter", layoutId: 12 }));
    expect((await resolveClimbIdentities(input([candidate(0)]))).size).toBe(0);
  });

  it("treats authentication rejection and account mismatch as fatal", async () => {
    useLookup(() => null, { status: 401 });
    await expect(resolveClimbIdentities(input([candidate(0)]))).rejects.toThrow(/authentication/i);

    server.resetHandlers();
    useLookup(() => null, { errors: [{ message: "Authentication required" }] });
    await expect(resolveClimbIdentities(input([candidate(0)]))).rejects.toThrow(/authentication/i);

    server.resetHandlers();
    useLookup(() => null, { accountId: "another-account" });
    await expect(resolveClimbIdentities(input([candidate(0)]))).rejects.toThrow(
      /different account/i,
    );
  });
});
