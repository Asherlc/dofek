/** @vitest-environment jsdom */
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { markers, resetMaps } from "../lib/maplibre-test-helpers.ts";
import { trpc } from "../lib/trpc.ts";
import {
  anchorId,
  emptyPasses,
  fetchReadyGhost,
  firstVisitGhost,
  fixtureQuery,
  GhostFixtureProvider,
  ghostError,
  ghostResponse,
  nameErrorGhost,
  priorId,
  readyGhost,
} from "./fixtures/ghost-sessions.tsx";
import { GhostMapLabelsSetting } from "./GhostMapLabelsSetting.tsx";
import { GhostSessions } from "./GhostSessions.tsx";

vi.mock("maplibre-gl", async () => (await import("../lib/maplibre-test-helpers.ts")).maplibreMock);
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url", () => ({
  default: "/maplibre-worker.js",
}));

beforeEach(() => {
  resetMaps();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function renderGhost(fetchResponse: typeof fetch = fetchReadyGhost) {
  render(
    <GhostFixtureProvider fetchResponse={fetchResponse}>
      <GhostSessions activityId={anchorId} />
    </GhostFixtureProvider>,
  );
}

it("loads an off-page suggestion, preserves an explicit pass through paging and links its workout", async () => {
  const fetchResponse = vi.fn(fetchReadyGhost);
  renderGhost(fetchResponse);
  expect(await screen.findByText("Previous best")).toBeVisible();
  expect(await screen.findByRole("link", { name: "Open Oct 1, 2026 activity" })).toHaveAttribute(
    "href",
    `/activity/${priorId}`,
  );
  expect(await screen.findByText("10s faster")).toBeVisible();
  expect(fetchResponse.mock.calls.map(([input]) => fixtureQuery(input))).toContainEqual({
    path: "/trpc/ghostSessions.compare",
    params: { activityId: anchorId, sectionId: "route", passId: "best" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Oct 1, 2026/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load more passes" }));
  await screen.findByRole("button", { name: /Sep 25, 2026/ });
  expect(fetchResponse.mock.calls.map(([input]) => fixtureQuery(input))).toContainEqual({
    path: "/trpc/ghostSessions.passes",
    params: { activityId: anchorId, sectionId: "route", cursor: "older", direction: "forward" },
  });
  expect(screen.getByRole("button", { name: /Oct 1, 2026/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(await screen.findByText("25s faster")).toBeVisible();
});

it("keeps a label error independent from partial history, recorded stops and missing metrics", async () => {
  renderGhost((input, init) =>
    fixtureQuery(input).path === "/trpc/ghostSessions.get"
      ? Promise.resolve(ghostResponse(nameErrorGhost))
      : fetchReadyGhost(input, init),
  );
  expect(await screen.findByText("Road and trail names could not be loaded.")).toBeVisible();
  expect(screen.getByText("Saved history is partial.")).toBeVisible();
  expect(await screen.findByText("25s faster")).toBeVisible();
  expect(screen.queryByText("Average heart rate")).toBeNull();
  expect(screen.getByText("0 W")).toBeVisible();
  const scrubber = screen.getByRole("slider", { name: "Replay elapsed time" });
  expect(scrubber).toHaveValue("0");
  expect(await screen.findByRole("img", { name: "Ghost position" })).toBeVisible();
  fireEvent.change(scrubber, { target: { value: "75000" } });
  expect(scrubber).toHaveAttribute("aria-valuetext", "1m 15s of 4m 25s");
  const current = markers.find(
    (marker) => marker.element.getAttribute("aria-label") === "This activity position",
  );
  const ghost = markers.find(
    (marker) => marker.element.getAttribute("aria-label") === "Ghost position",
  );
  expect(current?.coordinates).toEqual([-122.4845, 37.7704]);
  expect(ghost?.coordinates?.[0]).toBeCloseTo(-122.485025, 6);
  expect(ghost?.coordinates?.[1]).toBeCloseTo(37.770025, 6);
  fireEvent.change(scrubber, { target: { value: "82000" } });
  expect(current?.coordinates).toEqual([-122.4845, 37.7704]);
  expect(ghost?.coordinates?.[0]).toBeGreaterThan(-122.485025);
  fireEvent.click(screen.getByRole("button", { name: "Play replay" }));
  expect(screen.getByRole("button", { name: "Pause replay" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Pause replay" }));
  fireEvent.click(screen.getByRole("button", { name: "Restart replay" }));
  expect(scrubber).toHaveValue("0");
});

it("compares the selected named road and trail and resets replay on section change", async () => {
  const fetchResponse = vi.fn(fetchReadyGhost);
  renderGhost(fetchResponse);
  const road = await screen.findByRole("button", { name: "Martin Luther King Jr. Drive" });
  fireEvent.click(road);
  expect(await screen.findByText("10s slower")).toBeVisible();
  expect(
    screen.getByText("This comparison times the shared portion of the recorded section."),
  ).toBeVisible();
  expect(screen.getByRole("slider")).toHaveAttribute("max", "175000");
  expect(road).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("link", { name: "OpenStreetMap attribution" })).toHaveAttribute(
    "href",
    "https://www.openstreetmap.org/copyright",
  );
  fireEvent.change(screen.getByRole("slider"), { target: { value: "75000" } });
  fireEvent.click(screen.getByRole("button", { name: "Oak Woodland Trail" }));
  const slider = await screen.findByRole("slider", { name: "Replay elapsed time" });
  expect(slider).toHaveValue("0");
  expect(fetchResponse.mock.calls.map(([input]) => fixtureQuery(input))).toContainEqual({
    path: "/trpc/ghostSessions.compare",
    params: { activityId: anchorId, sectionId: "named", passId: "latest" },
  });
});

it("returns to the current server suggestion when a user-picked pass disappears", async () => {
  renderGhost((input, init) => {
    const { path, params } = fixtureQuery(input);
    if (path === "/trpc/ghostSessions.compare" && params.passId === "latest") {
      return Promise.resolve(ghostError("NOT_FOUND", "Ghost session not found"));
    }
    return fetchReadyGhost(input, init);
  });
  expect(await screen.findByText("10s faster")).toBeVisible();
  const pass = await screen.findByRole("button", { name: /Oct 1, 2026/ });
  fireEvent.click(pass);
  await waitFor(() => expect(pass).not.toBeInTheDocument());
  expect(screen.queryByRole("link", { name: "Open Oct 1, 2026 activity" })).toBeNull();
  expect(await screen.findByText("10s faster")).toBeVisible();
  expect(screen.getByText("Previous best")).toBeVisible();
});

it("falls back to an available past pass even when Get keeps suggesting a missing pass", async () => {
  let recovered = false;
  const fetchResponse = vi.fn<typeof fetch>(async (input, init) => {
    const { path, params } = fixtureQuery(input);
    if (path === "/trpc/ghostSessions.get") {
      return ghostResponse({
        ...readyGhost,
        nameStatus: "disabled",
        mapCoverage: undefined,
        sections: readyGhost.sections.filter((section) => section.kind === "route"),
      });
    }
    if (path === "/trpc/ghostSessions.compare" && params.passId === "best" && !recovered) {
      return ghostError("NOT_FOUND", "Ghost session not found");
    }
    return fetchReadyGhost(input, init);
  });
  renderGhost(fetchResponse);
  expect(await screen.findByText("25s faster")).toBeVisible();
  expect(screen.queryByText("Previous best")).toBeNull();
  expect(screen.getByRole("button", { name: /Oct 1, 2026/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const requests = () => fetchResponse.mock.calls.map(([input]) => fixtureQuery(input));
  await waitFor(() =>
    expect(requests().filter(({ path }) => path === "/trpc/ghostSessions.get")).toHaveLength(2),
  );
  expect(requests().filter(({ path }) => path === "/trpc/ghostSessions.passes")).toHaveLength(2);
  expect(requests().filter(({ params }) => params.passId === "best")).toHaveLength(1);
  recovered = true;
  fireEvent.click(screen.getByRole("button", { name: "Retry unavailable pass" }));
  expect(await screen.findByText("10s faster")).toBeVisible();
  expect(requests().filter(({ params }) => params.passId === "best")).toHaveLength(2);
});

it.each(["allowed", "withdrawn", "error"])(
  "pauses named display during the live consent check on focus and handles %s",
  async (outcome) => {
    let completeCheck = (_response: Response) => {};
    const check = new Promise<Response>((resolve) => {
      completeCheck = resolve;
    });
    let settingsReads = 0;
    function ConsentObservation() {
      const query = trpc.settings.get.useQuery({ key: "ghostMapLabels" }, { enabled: false });
      return <output>{query.isError ? "consent read failed" : String(query.data?.value)}</output>;
    }
    const fetchResponse: typeof fetch = async (input, init) => {
      const { path, params } = fixtureQuery(input);
      if (path === "/trpc/settings.get" && ++settingsReads === 2) {
        return check;
      }
      if (path === "/trpc/ghostSessions.passes" && params.sectionId === "named") {
        return ghostResponse({
          passes: [
            {
              passId: "best",
              activityId: priorId,
              startedAt: "2026-09-25T17:00:00.000Z",
              elapsedMs: 250_000,
            },
          ],
          nextCursor: null,
        });
      }
      return fetchReadyGhost(input, init);
    };
    render(
      <GhostFixtureProvider fetchResponse={fetchResponse}>
        <GhostSessions activityId={anchorId} />
        <ConsentObservation />
      </GhostFixtureProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Oak Woodland Trail" }));
    expect(await screen.findByText("25s faster")).toBeVisible();
    fireEvent.click(await screen.findByRole("button", { name: /Sep 25, 2026/ }));
    expect(await screen.findByText("10s faster")).toBeVisible();
    try {
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(settingsReads).toBe(2));
      expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Oak Woodland Trail" })).toBeNull();
      expect(await screen.findByText("10s faster")).toBeVisible();
      await act(async () => {
        completeCheck(
          outcome === "error"
            ? ghostError("INTERNAL_SERVER_ERROR", "Consent lookup failed")
            : ghostResponse({ key: "ghostMapLabels", value: outcome === "allowed" }),
        );
      });
      if (outcome === "allowed") {
        expect(await screen.findByRole("button", { name: "Oak Woodland Trail" })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
        expect(await screen.findByRole("button", { name: /Sep 25, 2026/ })).toHaveAttribute(
          "aria-pressed",
          "true",
        );
      } else {
        await screen.findByText(outcome === "error" ? "consent read failed" : "false");
        expect(screen.queryByText("Oak Woodland Trail")).toBeNull();
        expect(screen.getByText("10s faster")).toBeVisible();
        await act(async () => {
          focusManager.setFocused(false);
          focusManager.setFocused(true);
        });
        expect(await screen.findByRole("button", { name: "Oak Woodland Trail" })).toHaveAttribute(
          "aria-pressed",
          "false",
        );
        expect(screen.queryByRole("heading", { name: "Oak Woodland Trail" })).toBeNull();
      }
    } finally {
      await act(async () => focusManager.setFocused(undefined));
    }
  },
);

it.each(["replacement", "refresh error"])(
  "waits for new Ghost evidence after a live true setting following cross-device off/on (%s)",
  async (outcome) => {
    let refocused = false;
    let settingsSettled = false;
    let settingsReads = 0;
    let completeSettings = (_response: Response) => {};
    const settings = new Promise<Response>((resolve) => {
      completeSettings = resolve;
    });
    let completeGet = (_response: Response) => {};
    const refresh = new Promise<Response>((resolve) => {
      completeGet = resolve;
    });
    let freshGets = 0;
    const currentResult = () =>
      ghostResponse({
        ...readyGhost,
        sections: readyGhost.sections.map((section) =>
          section.kind === "named-trail"
            ? { ...section, sectionId: "current-trail", name: "Current trail name" }
            : section,
        ),
      });
    renderGhost(async (input, init) => {
      const { path } = fixtureQuery(input);
      if (refocused && path === "/trpc/settings.get" && ++settingsReads === 1) {
        return settings;
      }
      if (refocused && path === "/trpc/ghostSessions.get") {
        expect(settingsSettled).toBe(true);
        return ++freshGets === 1 ? refresh : currentResult();
      }
      return fetchReadyGhost(input, init);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Oak Woodland Trail" }));
    expect(await screen.findByText("25s faster")).toBeVisible();
    try {
      refocused = true;
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });
      await waitFor(() => expect(settingsReads).toBe(1));
      expect(freshGets).toBe(0);
      expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
      await act(async () => {
        settingsSettled = true;
        completeSettings(ghostResponse({ key: "ghostMapLabels", value: true }));
      });
      await waitFor(() => expect(freshGets).toBe(1));
      expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Oak Woodland Trail" })).toBeNull();
      expect(await screen.findByText("10s faster")).toBeVisible();
      await act(async () => {
        completeGet(
          outcome === "replacement"
            ? currentResult()
            : ghostError("INTERNAL_SERVER_ERROR", "Ghost refresh failed"),
        );
      });
      if (outcome === "refresh error") {
        expect(await screen.findByRole("alert")).toHaveTextContent("Ghost refresh failed");
        expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
        expect(screen.getByText("10s faster")).toBeVisible();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      }
      expect(await screen.findByRole("button", { name: "Current trail name" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
      expect(freshGets).toBe(outcome === "replacement" ? 1 : 2);
    } finally {
      await act(async () => focusManager.setFocused(undefined));
    }
  },
);

it("keeps names hidden when canceling the verification Get restores a successful cached result", async () => {
  vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
  let refocused = false;
  let focusedGets = 0;
  let finishCanceledGet = (_response: Response) => {};
  const pending = new Promise<Response>((resolve) => {
    finishCanceledGet = resolve;
  });
  let cancellation: Promise<void> | undefined;
  function CancelFixture() {
    const utils = trpc.useUtils();
    return (
      <button
        type="button"
        onClick={() => {
          cancellation = utils.ghostSessions.get.cancel({ activityId: anchorId });
        }}
      >
        Cancel verification Get
      </button>
    );
  }
  const fetchResponse: typeof fetch = (input, init) => {
    if (
      refocused &&
      fixtureQuery(input).path === "/trpc/ghostSessions.get" &&
      ++focusedGets === 1
    ) {
      return pending;
    }
    return fetchReadyGhost(input, init);
  };
  render(
    <GhostFixtureProvider fetchResponse={fetchResponse}>
      <GhostSessions activityId={anchorId} />
      <CancelFixture />
    </GhostFixtureProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: "Oak Woodland Trail" }));
  expect(await screen.findByText("25s faster")).toBeVisible();
  try {
    refocused = true;
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(focusedGets).toBe(1));
    expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Cancel verification Get" }));
      await cancellation;
      finishCanceledGet(ghostResponse(readyGhost));
    });
    expect(screen.queryByRole("button", { name: "Oak Woodland Trail" })).toBeNull();
    expect(await screen.findByText("10s faster")).toBeVisible();

    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(await screen.findByRole("button", { name: "Oak Woodland Trail" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(focusedGets).toBe(2);
  } finally {
    await act(async () => focusManager.setFocused(undefined));
  }
});

it("keeps the selected comparison and scrub position through an in-flight background refresh", async () => {
  let refreshing = false;
  const fetchResponse: typeof fetch = async (input, init) => {
    if (refreshing && fixtureQuery(input).path === "/trpc/ghostSessions.compare") {
      return new Promise<Response>(() => {});
    }
    return fetchReadyGhost(input, init);
  };
  function RefreshFixture() {
    const utils = trpc.useUtils();
    return (
      <button type="button" onClick={() => void utils.ghostSessions.invalidate()}>
        Refresh results
      </button>
    );
  }
  render(
    <GhostFixtureProvider fetchResponse={fetchResponse}>
      <GhostSessions activityId={anchorId} />
      <RefreshFixture />
    </GhostFixtureProvider>,
  );
  const pass = await screen.findByRole("button", { name: /Oct 1, 2026/ });
  fireEvent.click(pass);
  const slider = await screen.findByRole("slider", { name: "Replay elapsed time" });
  fireEvent.change(slider, { target: { value: "68000" } });
  refreshing = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh results" }));
  await waitFor(() => expect(screen.getByText("25s faster")).toBeVisible());
  expect(slider).toHaveValue("68000");
  expect(pass).toHaveAttribute("aria-pressed", "true");
});

it("shows a recorded named interval while no prepared matches are available", async () => {
  renderGhost((input, init) => {
    const { path, params } = fixtureQuery(input);
    if (path === "/trpc/ghostSessions.get") {
      return Promise.resolve(
        ghostResponse({
          ...readyGhost,
          sections: readyGhost.sections.map((section) =>
            section.sectionId === "named"
              ? { ...section, suggestedGhost: null, geometry: undefined }
              : section,
          ),
        }),
      );
    }
    if (path === "/trpc/ghostSessions.passes" && params.sectionId === "named") {
      return Promise.resolve(ghostError("NOT_FOUND", "Ghost session not found"));
    }
    return fetchReadyGhost(input, init);
  });
  fireEvent.click(await screen.findByRole("button", { name: "Oak Woodland Trail" }));
  expect(
    await screen.findByText("No earlier comparable pass in the history checked so far."),
  ).toBeVisible();
  expect(screen.getByText(/recorded elapsed/)).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("renders ready first-visit geometry and elapsed without querying or offering replay", async () => {
  const fetchResponse = vi.fn<typeof fetch>(async (input) => {
    const { path } = fixtureQuery(input);
    if (path === "/trpc/ghostSessions.get") return ghostResponse(firstVisitGhost);
    if (path === "/trpc/ghostSessions.passes") return ghostResponse(emptyPasses);
    throw new Error(`Unexpected fixture request ${path}`);
  });
  renderGhost(fetchResponse);
  expect(await screen.findByText("First visit")).toBeVisible();
  expect(await screen.findByText("This is your first recorded visit.")).toBeVisible();
  expect(screen.getByText(/recorded elapsed/)).toHaveTextContent("4m");
  expect(screen.getByRole("region", { name: "Recorded activity route" })).toBeVisible();
  expect(screen.queryByRole("slider")).toBeNull();
  expect(fetchResponse.mock.calls.map(([input]) => fixtureQuery(input).path)).toEqual([
    "/trpc/ghostSessions.get",
    "/trpc/ghostSessions.passes",
  ]);
});

it("prepares a processing activity without asking for comparisons or consent", async () => {
  const fetchResponse = vi.fn<typeof fetch>(async () =>
    ghostResponse({
      availability: "processing",
      sport: null,
      gpsCoverage: null,
      historyCoverage: "partial",
      nameStatus: "disabled",
      sections: [],
    }),
  );
  renderGhost(fetchResponse);
  expect(await screen.findByLabelText("Preparing Ghost Sessions.")).toBeVisible();
  expect(fetchResponse).toHaveBeenCalledOnce();
});

it("withdraws named sections immediately, even while the last Get response still contains names", async () => {
  let allowed = true;
  let finishSave = () => {};
  const save = new Promise<void>((resolve) => {
    finishSave = resolve;
  });
  const fetchResponse = vi.fn<typeof fetch>(async (input, init) => {
    switch (fixtureQuery(input).path) {
      case "/trpc/settings.get":
        return ghostResponse({ key: "ghostMapLabels", value: allowed });
      case "/trpc/settings.set":
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ key: "ghostMapLabels", value: false });
        await save;
        allowed = false;
        return ghostResponse({ key: "ghostMapLabels", value: false });
      default:
        return fetchReadyGhost(input, init);
    }
  });
  render(
    <GhostFixtureProvider fetchResponse={fetchResponse}>
      <GhostMapLabelsSetting />
      <GhostSessions activityId={anchorId} />
    </GhostFixtureProvider>,
  );
  expect(await screen.findByText("10s faster")).toBeVisible();
  const label = await screen.findByRole("button", { name: "Oak Woodland Trail" });
  fireEvent.click(label);
  expect(await screen.findByText("25s faster")).toBeVisible();
  const preference = screen.getByRole("checkbox", { name: /show road and trail names/i });
  expect(preference).toBeChecked();
  fireEvent.click(preference);
  await waitFor(() => expect(screen.queryByText("Oak Woodland Trail")).toBeNull());
  expect(preference).not.toBeChecked();
  expect(preference).toBeDisabled();
  expect(screen.queryByRole("link", { name: "OpenStreetMap attribution" })).toBeNull();
  expect(screen.getByRole("button", { name: "Unnamed climb" })).toBeVisible();
  expect(await screen.findByText("10s faster")).toBeVisible();

  await act(async () => finishSave());
  await waitFor(() => expect(preference).toBeEnabled());
  expect(screen.queryByText("Martin Luther King Jr. Drive")).toBeNull();
  expect(screen.getByRole("slider", { name: "Replay elapsed time" })).toBeVisible();
  expect(
    fetchResponse.mock.calls.filter(
      ([input]) => fixtureQuery(input).path === "/trpc/ghostSessions.get",
    ),
  ).toHaveLength(3);
  expect(readyGhost.sections.some((item) => item.kind === "named-trail")).toBe(true);
});
