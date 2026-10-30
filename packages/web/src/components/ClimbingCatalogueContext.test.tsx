// @vitest-environment jsdom
import type { ClimbingCatalogueContext as Context } from "@dofek/training/climbing-catalogue";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ClimbingCatalogueContext } from "./ClimbingCatalogueContext";

const { useQuery, useMutation, mutate, setData, refetch } = vi.hoisted(() => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
  mutate: vi.fn(),
  setData: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("../lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ climbing: { catalogueContext: { setData } } }),
    climbing: { catalogueContext: { useQuery }, refreshCatalogueContext: { useMutation } },
  },
}));
const missing: Context = {
  status: "missing",
  fetchedAt: null,
  expiresAt: null,
  error: null,
  sources: [],
};
const ready: Context = {
  ...missing,
  status: "ready",
  sources: [
    {
      providerId: "kaya",
      searchComplete: false,
      matches: [
        {
          confidence: "possible",
          candidate: {
            providerId: "kaya",
            externalId: "1",
            url: "https://kaya-app.kayaclimb.com/climb/1",
            name: "The Arete",
            kind: "boulder",
            setting: "outdoor",
            locations: [],
            grade: "V4",
            angle: { value: 25, unit: null },
            tags: [
              {
                kind: "steepness",
                sourceKey: "slab",
                label: "Slab",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "steepness",
                sourceKey: "overhang",
                label: "Overhang",
                category: null,
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "hold",
                sourceKey: "crimp",
                label: "Crimps",
                category: null,
                scope: "inherited",
                inheritedFrom: "The Valley",
              },
              {
                kind: "other",
                sourceKey: "movement-1",
                label: "Source movement",
                category: "Movement",
                scope: "direct",
                inheritedFrom: null,
              },
              {
                kind: "other",
                sourceKey: "arete",
                label: "Arête",
                category: null,
                scope: "inherited",
                inheritedFrom: "The Valley",
              },
            ],
          },
        },
      ],
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: missing,
    error: null,
    isLoading: false,
  });
  useMutation.mockReturnValue({ mutate, error: null, isPending: false });
});
function open() {
  fireEvent.click(screen.getByRole("button", { name: "Catalogue context" }));
}
it("opens cached context only on disclosure and explicitly requests discovery", () => {
  render(<ClimbingCatalogueContext id="log-1" />);
  expect(useQuery).not.toHaveBeenCalled();
  open();
  expect(useQuery.mock.lastCall?.[1].enabled).toBe(true);
  expect(useQuery.mock.lastCall?.[1].staleTime).toBe(0);
  expect(screen.queryByText(/^Fetched /)).toBeNull();
  expect(
    screen.getByRole("button", { name: "Catalogue context" }).getAttribute("aria-expanded"),
  ).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Find catalogue info" }));
  expect(mutate).toHaveBeenCalledWith({ id: "log-1" });
});
it("qualifies possible matches, inherited tags, multiple steepness and unknown angle units", () => {
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: ready,
    error: null,
    isLoading: false,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText(/Possible match/)).toBeTruthy();
  expect(screen.getByText("Catalogue grade: V4")).toBeTruthy();
  expect(screen.getByText(/Slab/)).toBeTruthy();
  expect(screen.getByText(/Overhang/)).toBeTruthy();
  expect(screen.getByText(/Crimps \(inherited from The Valley\)/)).toBeTruthy();
  expect(screen.getByText("Movement: Source movement")).toBeTruthy();
  expect(screen.getByText("Tag: Arête (inherited from The Valley)")).toBeTruthy();
  expect(screen.getByText("Source angle: 25 (units not supplied)")).toBeTruthy();
  expect(screen.getByText(/Search incomplete/)).toBeTruthy();
});
it("retains cached context and exact errors when refresh fails", () => {
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: ready,
    error: new Error("Catalogue lookup unavailable."),
    isLoading: false,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText("Catalogue lookup unavailable.")).toBeTruthy();
  expect(screen.getByText("Catalogue grade: V4")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh catalogue info" }));
  expect(mutate).toHaveBeenCalledWith({ id: "log-1" });
});
it("polls pending lookups and stops on terminal status or errors", () => {
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: { ...missing, status: "pending" },
    error: null,
    isLoading: false,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText("Looking up catalogue info…")).toBeTruthy();
  const interval = useQuery.mock.lastCall?.[1].refetchInterval;
  expect(interval({ state: { data: { status: "pending" }, error: null } })).toBe(1500);
  expect(interval({ state: { data: { status: "ready" }, error: null } })).toBe(false);
  expect(interval({ state: { data: { status: "pending" }, error: new Error("failed") } })).toBe(
    false,
  );
  const pending = { ...missing, status: "pending" };
  useMutation.mock.lastCall?.[0].onSuccess(pending);
  expect(setData).toHaveBeenCalledWith({ id: "log-1" }, pending);
});
it("distinguishes a completed empty catalogue lookup", () => {
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: { ...missing, status: "ready" },
    error: null,
    isLoading: false,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText("No catalogue candidates found in the searched sources.")).toBeTruthy();
});

it.each([
  ["source", "Own source"],
  ["reference", "Provider reference"],
  ["corroborated", "Location corroborated"],
] as const)("labels %s evidence separately from possible matches", (confidence, label) => {
  const source = ready.sources[0];
  if (!source) throw new Error("Missing fixture source");
  const match = source.matches[0];
  if (!match) throw new Error("Missing fixture match");
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: {
      ...ready,
      sources: [
        {
          ...source,
          matches: [
            {
              ...match,
              confidence,
              candidate: {
                ...match.candidate,
                angle: { value: 0, unit: "degrees" },
                tags: [
                  {
                    kind: "hold",
                    sourceKey: "sloper",
                    label: "Slopers",
                    category: null,
                    scope: "inherited",
                    inheritedFrom: null,
                  },
                ],
              },
            },
          ],
        },
      ],
    },
    error: null,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText(label)).toBeTruthy();
  expect(screen.getByText("Source angle: 0°")).toBeTruthy();
  expect(screen.getByText("Holds: Slopers (inherited)")).toBeTruthy();
});
it("offers recovery when polling fails during a pending lookup", () => {
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: { ...missing, status: "pending" },
    error: new Error("Reconnect to check catalogue status."),
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText("Reconnect to check catalogue status.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Refresh catalogue info" }));
  expect(mutate).toHaveBeenCalledWith({ id: "log-1" });
});

it("shows the cached fetch date once", () => {
  const fetchedAt = "2026-10-27T12:30:00Z";
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    data: { ...ready, fetchedAt },
    error: null,
    isLoading: false,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getAllByText(`Fetched ${new Date(fetchedAt).toLocaleString()}`)).toHaveLength(1);
});

afterEach(() => vi.useRealTimers());
it.each(["NOT_FOUND", "UNAUTHORIZED", "FORBIDDEN", "PRECONDITION_FAILED"])(
  "hides retained cache after %s authorization failure",
  (code) => {
    useQuery.mockReturnValue({
      data: ready,
      isFetchedAfterMount: true,
      refetch,
      error: { message: "Climbing log not found", data: { code } },
    });
    render(<ClimbingCatalogueContext id="log-1" />);
    open();
    expect(screen.queryByText("Catalogue grade: V4")).toBeNull();
    expect(screen.getByText("Climbing log not found")).toBeTruthy();
  },
);
it("withholds prior context until ownership is revalidated after mount", () => {
  useQuery.mockReturnValue({
    data: ready,
    isFetchedAfterMount: false,
    refetch,
    isFetching: true,
    error: null,
  });
  const view = render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.queryByText("Catalogue grade: V4")).toBeNull();
  expect(screen.getByText("Loading catalogue context…")).toBeTruthy();
  useQuery.mockReturnValue({
    data: ready,
    isFetchedAfterMount: true,
    refetch,
    isFetching: false,
    error: null,
  });
  view.rerender(<ClimbingCatalogueContext id="log-1" />);
  expect(screen.getByText("Catalogue grade: V4")).toBeTruthy();
});
it.each(["ready", "error"] as const)(
  "hides %s context and revalidates once at expiry while mounted",
  (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-27T12:00:00Z"));
    useQuery.mockReturnValue({
      data: { ...ready, status, expiresAt: "2026-10-27T12:00:01Z" },
      isFetchedAfterMount: true,
      refetch,
      error: null,
    });
    render(<ClimbingCatalogueContext id="log-1" />);
    open();
    expect(screen.getByText("Catalogue grade: V4")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText("Catalogue grade: V4")).toBeNull();
    expect(refetch).toHaveBeenCalledOnce();
    act(() => {
      vi.advanceTimersByTime(30000);
    });
    expect(refetch).toHaveBeenCalledOnce();
  },
);
it("keeps unexpired context when only refresh mutation fails", () => {
  useQuery.mockReturnValue({
    data: { ...ready, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    isFetchedAfterMount: true,
    refetch,
    error: null,
  });
  useMutation.mockReturnValue({
    mutate,
    error: new Error("Catalogue refresh could not be queued."),
    isPending: false,
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText("Catalogue grade: V4")).toBeTruthy();
  expect(screen.getByText("Catalogue refresh could not be queued.")).toBeTruthy();
});

it("shows all catalogue climb types separately from wall and personal ascent facts", () => {
  const source = ready.sources[0];
  const match = source?.matches[0];
  if (!source || !match) throw new Error("Missing fixture match");
  const labels = ["Trad", "Sport", "Top rope", "Mixed trad", "Aid"];
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    error: null,
    data: {
      ...ready,
      sources: [
        {
          ...source,
          matches: [
            {
              ...match,
              candidate: {
                ...match.candidate,
                tags: labels.map((label) => ({
                  kind: "climb_type",
                  sourceKey: "type",
                  label,
                  category: null,
                  scope: "direct",
                  inheritedFrom: null,
                })),
              },
            },
          ],
        },
      ],
    },
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  for (const label of labels) expect(screen.getByText(`Climb type: ${label}`)).toBeTruthy();
});

it.each([
  [
    "reference",
    [
      "Explicit Mountain Project reference 105736399.",
      "Catalogue name differs from the logged name.",
    ],
  ],
  [
    "possible",
    [
      "Explicit Mountain Project reference 105736399.",
      "Conflict: local areas differ: Goat Rock and Chew Tooth.",
    ],
  ],
] as const)(
  "displays server evidence for a %s match within the local search area",
  (confidence, evidence) => {
    const source = ready.sources[0];
    const match = source?.matches[0];
    if (!source || !match) throw new Error("Missing fixture match");
    useQuery.mockReturnValue({
      isFetchedAfterMount: true,
      refetch,
      error: null,
      data: {
        ...ready,
        sources: [
          {
            ...source,
            searchArea: {
              externalId: "goat-rock",
              name: "Goat Rock",
              scope: "area",
              coordinates: null,
            },
            matches: [
              {
                ...match,
                confidence,
                evidence: [...evidence],
                candidate: { ...match.candidate, name: "Corner Route" },
              },
            ],
          },
        ],
      },
    });
    render(<ClimbingCatalogueContext id="log-1" />);
    open();
    expect(screen.getByText("Search area: Goat Rock")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Corner Route" })).toBeTruthy();
    for (const reason of evidence) expect(screen.getByText(reason)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Catalogue context" }));
    expect(
      screen.getByRole("button", { name: "Catalogue context" }).getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByText(evidence[0])).toBeNull();
  },
);

it("qualifies empty results when local discovery is incomplete", () => {
  useQuery.mockReturnValue({
    isFetchedAfterMount: true,
    refetch,
    error: null,
    data: {
      ...ready,
      sources: [
        {
          providerId: "openbeta",
          searchComplete: false,
          searchArea: {
            externalId: "goat-rock",
            name: "Goat Rock",
            scope: "area",
            coordinates: null,
          },
          matches: [],
        },
      ],
    },
  });
  render(<ClimbingCatalogueContext id="log-1" />);
  open();
  expect(screen.getByText("No catalogue candidates found in the searched sources.")).toBeTruthy();
  expect(screen.getByText("Search area: Goat Rock")).toBeTruthy();
  expect(screen.getByText("Search incomplete; more candidates may exist.")).toBeTruthy();
});
