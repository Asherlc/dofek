// @vitest-environment jsdom
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PageLoadProvider,
  recordPageNavigationStart,
  usePageLoad,
  usePageLoadDomSection,
  usePageLoadSection,
} from "./page-load-context.tsx";

const capture = vi.hoisted(() => vi.fn());
vi.mock("./posthog.ts", () => ({ capturePageLoad: capture }));
let frames: FrameRequestCallback[] = [];
const measure = vi.fn();
let retainedComplete: ((status: "ready", time: number) => void) | undefined;
function frame(time: number) {
  const pending = frames;
  frames = [];
  act(() =>
    pending.forEach((callback) => {
      callback(time);
    }),
  );
}
function Section({ status = "ready" }: { status?: "ready" | "empty" | "error" | undefined }) {
  usePageLoadDomSection("cards", status);
  const context = usePageLoad();
  const { complete, generation } = usePageLoadSection("chart");
  if (generation !== undefined) retainedComplete ??= complete;
  return (
    <>
      <p>Visible data</p>
      <button type="button" onClick={(event) => context?.beginFilter(event.timeStamp)}>
        Filter
      </button>
      <button type="button" onClick={() => complete("ready", 450)}>
        Render chart
      </button>
    </>
  );
}
function view(enabled = true, sections = ["cards"]) {
  return (
    <PageLoadProvider route="/dashboard" startedAt={100} sections={sections} enabled={enabled}>
      <Section />
    </PageLoadProvider>
  );
}
beforeEach(() => {
  frames = [];
  retainedComplete = undefined;
  capture.mockClear();
  measure.mockClear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("performance", { now: () => 500, measure });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("page load React adapter", () => {
  it("cancels immediately when navigation begins before the next route mounts", () => {
    render(view(true, ["chart"]));
    act(() => recordPageNavigationStart(200));
    fireEvent.click(screen.getByText("Render chart"));
    expect(measure.mock.calls.map(([name]) => name)).toEqual(["dofek.page.data-outcome"]);
    expect(capture.mock.calls.at(-1)?.[0]).toMatchObject({
      outcome: "cancelled",
      completedAt: 200,
    });
  });
  it("completes the mounted generation under React StrictMode", () => {
    render(<StrictMode>{view()}</StrictMode>);
    frame(200);
    frame(250);
    expect(measure).toHaveBeenCalledWith(
      "dofek.page.data-ready",
      expect.objectContaining({ end: 250 }),
    );
  });
  it("waits for commit and a paint opportunity before completing visible DOM", () => {
    render(view());
    expect(screen.getByText("Visible data")).toBeTruthy();
    expect(measure).not.toHaveBeenCalled();
    frame(200);
    expect(measure).not.toHaveBeenCalled();
    frame(250);
    expect(measure).toHaveBeenCalledWith("dofek.page.data-ready", {
      start: 100,
      end: 250,
      detail: { route: "/dashboard", kind: "navigation", outcome: "ready", generation: 1 },
    });
  });
  it("waits for a generation-bound chart callback and never duplicates completion", () => {
    render(view(true, ["cards", "chart"]));
    frame(200);
    frame(250);
    expect(measure).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Render chart"));
    fireEvent.click(screen.getByText("Render chart"));
    expect(measure).toHaveBeenCalledTimes(1);
    expect(measure).toHaveBeenLastCalledWith(
      "dofek.page.data-ready",
      expect.objectContaining({ end: 450 }),
    );
  });
  it("ignores queued callbacks after unmount", () => {
    const rendered = render(view());
    frame(200);
    rendered.unmount();
    frame(250);
    expect(measure.mock.calls.map(([name]) => name)).toEqual(["dofek.page.data-outcome"]);
    expect(capture.mock.calls.map(([event]) => event.outcome)).toEqual(["cancelled"]);
  });
  it("disables emission for account erasure", () => {
    render(view(false));
    frame(200);
    frame(250);
    expect(measure).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
  it("starts filters at the input timestamp and cancels the prior generation", () => {
    render(view(true, ["cards", "chart"]));
    const button = screen.getByText("Filter");
    const event = createEvent.click(button);
    Object.defineProperty(event, "timeStamp", { value: 300 });
    fireEvent(button, event);
    frame(200);
    frame(250);
    fireEvent.click(screen.getByText("Render chart"));
    expect(capture.mock.calls.at(-1)?.[0]).toMatchObject({
      generation: 2,
      kind: "filter",
      outcome: "ready",
      startedAt: 300,
      durationMs: 150,
    });
    expect(capture.mock.calls[0]?.[0].outcome).toBe("cancelled");
  });
  it("ignores renderer callbacks retained from the previous generation", () => {
    render(view(true, ["chart"]));
    fireEvent.click(screen.getByText("Filter"));
    act(() => retainedComplete?.("ready", 400));
    expect(measure.mock.calls.map(([name]) => name)).toEqual(["dofek.page.data-outcome"]);
    fireEvent.click(screen.getByText("Render chart"));
    expect(capture.mock.calls.at(-1)?.[0]).toMatchObject({ generation: 2, outcome: "ready" });
  });
  it("stops an already mounted generation from emitting during erasure", () => {
    const rendered = render(view());
    frame(200);
    rendered.rerender(view(false));
    frame(250);
    expect(measure).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});
