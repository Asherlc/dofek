import {
  type GhostSessionsPassesResponse,
  ghostSessionsCompareInputSchema,
  ghostSessionsCompareResponseSchema,
  ghostSessionsGetInputSchema,
  ghostSessionsGetResponseSchema,
  ghostSessionsPassesInputSchema,
} from "@dofek/training/ghost-sessions";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { httpLink } from "@trpc/client";
import { createContext, type ReactNode, use, useState } from "react";
import { trpc } from "../../lib/trpc.ts";

export const anchorId = "709eda73-17fc-415d-8789-8f99278dc07d";
export const priorId = "c1f95b6f-f1f8-4f29-9c20-391a9a5db8bf";
const geometry = [
  { lat: 37.7689, lng: -122.4866 },
  { lat: 37.7704, lng: -122.4845 },
  { lat: 37.771, lng: -122.4826 },
  { lat: 37.7721, lng: -122.48 },
];
const start = Date.parse("2026-10-15T17:00:00Z");
const priorStart = Date.parse("2026-10-01T17:00:00Z");
const bestStart = Date.parse("2026-09-25T17:00:00Z");

function position(index: number, timestampMs: number) {
  const coordinate = geometry.at(index);
  if (!coordinate) throw new Error("Missing fixture coordinate");
  return { ...coordinate, timestampMs, distanceMeters: index * 250 };
}

const comparison = ghostSessionsCompareResponseSchema.parse({
  anchor: {
    start: position(0, start),
    end: position(3, start + 240_000),
    elapsedMs: 240_000,
  },
  candidate: {
    start: position(0, priorStart),
    end: position(3, priorStart + 265_000),
    elapsedMs: 265_000,
  },
  elapsedDifferenceMs: -25_000,
  timeBasis: "elapsed-including-recorded-stops",
  replay: [
    { anchor: position(0, start), candidate: position(0, priorStart) },
    {
      anchor: position(1, start + 65_000),
      candidate: position(1, priorStart + 100_000),
    },
    {
      anchor: position(1, start + 85_000),
      candidate: position(2, priorStart + 180_000),
    },
    {
      anchor: position(3, start + 240_000),
      candidate: position(3, priorStart + 265_000),
    },
  ],
  replayDownsampled: true,
  metrics: {
    paceSecondsPerKm: { anchor: 320, candidate: 265 / 0.75 },
    heartRateBpm: null,
    powerWatts: { anchor: 0, candidate: 215 },
  },
});

const bestComparison = ghostSessionsCompareResponseSchema.parse({
  ...comparison,
  candidate: {
    start: position(0, bestStart),
    end: position(3, bestStart + 250_000),
    elapsedMs: 250_000,
  },
  elapsedDifferenceMs: -10_000,
  replay: comparison.replay?.map(({ anchor, candidate }) => ({
    anchor,
    candidate: {
      ...candidate,
      timestampMs: bestStart + ((candidate.timestampMs - priorStart) * 250) / 265,
    },
  })),
  metrics: {
    ...comparison.metrics,
    paceSecondsPerKm: { anchor: 320, candidate: 250 / 0.75 },
  },
});

const roadComparison = ghostSessionsCompareResponseSchema.parse({
  ...comparison,
  anchor: { ...comparison.anchor, start: position(1, start + 65_000), elapsedMs: 175_000 },
  candidate: {
    ...comparison.candidate,
    start: position(1, priorStart + 100_000),
    elapsedMs: 165_000,
  },
  elapsedDifferenceMs: 10_000,
  replay: comparison.replay?.slice(1),
  metrics: {
    ...comparison.metrics,
    paceSecondsPerKm: { anchor: 350, candidate: 330 },
  },
});

export const readyGhost = ghostSessionsGetResponseSchema.parse({
  availability: "ready",
  sport: "running",
  gpsCoverage: "complete",
  historyCoverage: "complete",
  nameStatus: "ready",
  mapCoverage: "complete",
  sections: [
    {
      kind: "named-road",
      sectionId: "road",
      name: "Martin Luther King Jr. Drive",
      attribution: "Geoapify",
      anchor: comparison.anchor,
      suggestedGhost: { passId: "latest", reason: "most-recent" },
      geometry: [geometry],
    },
    {
      kind: "route",
      sectionId: "route",
      anchor: comparison.anchor,
      suggestedGhost: { passId: "best", reason: "previous-best" },
      geometry: [geometry],
    },
    {
      kind: "named-trail",
      sectionId: "named",
      name: "Oak Woodland Trail",
      attribution: "Geoapify · OpenStreetMap contributors",
      anchor: comparison.anchor,
      suggestedGhost: { passId: "latest", reason: "most-recent" },
      geometry: [geometry],
    },
    {
      kind: "unnamed-climb",
      sectionId: "climb",
      anchor: comparison.anchor,
      suggestedGhost: null,
      geometry: [geometry],
    },
  ],
});

const recentPasses: GhostSessionsPassesResponse = {
  passes: [
    {
      passId: "latest",
      activityId: priorId,
      startedAt: "2026-10-01T17:00:00.000Z",
      elapsedMs: 265_000,
    },
  ],
  nextCursor: "older",
};
const olderPasses: GhostSessionsPassesResponse = {
  passes: [
    {
      passId: "best",
      activityId: "c8ad2324-d2df-4e53-be28-9e4e865773b6",
      startedAt: "2026-09-25T17:00:00.000Z",
      elapsedMs: 250_000,
    },
  ],
  nextCursor: null,
};

export function ghostResponse(data: unknown) {
  return Response.json({ result: { data } });
}

export function fixtureQuery(input: Parameters<typeof fetch>[0]): {
  path: string;
  params: {
    activityId?: string;
    sectionId?: string;
    cursor?: string;
    direction?: string;
    passId?: string;
  };
} {
  const url = new URL(String(input));
  return {
    path: url.pathname,
    params: JSON.parse(url.searchParams.get("input") ?? "{}"),
  };
}

export function ghostError(code: "NOT_FOUND" | "INTERNAL_SERVER_ERROR", message: string) {
  const status = code === "NOT_FOUND" ? 404 : 500;
  return Response.json(
    {
      error: {
        code: code === "NOT_FOUND" ? -32004 : -32603,
        data: { code, httpStatus: status },
        message,
      },
    },
    { status },
  );
}

export const emptyPasses: GhostSessionsPassesResponse = { passes: [], nextCursor: null };
const route = readyGhost.sections.filter((section) => section.kind === "route");
export const firstVisitGhost = ghostSessionsGetResponseSchema.parse({
  ...readyGhost,
  nameStatus: "disabled",
  mapCoverage: undefined,
  sections: route.map((section) => ({ ...section, suggestedGhost: null, firstVisit: true })),
});
export const nameErrorGhost = ghostSessionsGetResponseSchema.parse({
  ...readyGhost,
  historyCoverage: "partial",
  nameStatus: "error",
  mapCoverage: undefined,
  sections: route.map((section) => ({
    ...section,
    suggestedGhost: { passId: "latest", reason: "most-recent" },
  })),
});

export const fetchReadyGhost: typeof fetch = async (input) => {
  const { path, params } = fixtureQuery(input);
  switch (path) {
    case "/trpc/ghostSessions.get":
      ghostSessionsGetInputSchema.parse(params);
      return ghostResponse(readyGhost);
    case "/trpc/ghostSessions.passes":
      ghostSessionsPassesInputSchema.parse(params);
      if (params.sectionId === "climb") return ghostResponse(emptyPasses);
      if (params.sectionId === "road") {
        return ghostResponse({
          passes: recentPasses.passes.map((pass) => ({
            ...pass,
            elapsedMs: roadComparison.candidate.elapsedMs,
          })),
          nextCursor: null,
        } satisfies GhostSessionsPassesResponse);
      }
      if (params.sectionId !== "route") return ghostResponse({ ...recentPasses, nextCursor: null });
      return ghostResponse(params.cursor ? olderPasses : recentPasses);
    case "/trpc/ghostSessions.compare":
      ghostSessionsCompareInputSchema.parse(params);
      if (params.sectionId === "road") return ghostResponse(roadComparison);
      return ghostResponse(params.passId === "best" ? bestComparison : comparison);
    case "/trpc/settings.get":
      return ghostResponse({ key: "ghostMapLabels", value: true });
    default:
      throw new Error(`Unexpected fixture request ${path}`);
  }
};

const FixtureContent = createContext<ReactNode>(null);

function FixtureRoute() {
  return use(FixtureContent);
}

export function GhostFixtureProvider({
  children,
  fetchResponse,
}: {
  children: ReactNode;
  fetchResponse: typeof fetch;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, gcTime: Infinity, refetchOnWindowFocus: false },
        },
      }),
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [httpLink({ url: "http://fixture.invalid/trpc", fetch: fetchResponse })],
    }),
  );
  const [router] = useState(() => {
    const root = createRootRoute({ component: Outlet });
    const story = createRoute({ getParentRoute: () => root, path: "/", component: FixtureRoute });
    const activity = createRoute({ getParentRoute: () => root, path: "activity/$id" });
    return createRouter({
      routeTree: root.addChildren([story, activity]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });

  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <FixtureContent.Provider value={children}>
          <RouterProvider router={router} />
        </FixtureContent.Provider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
