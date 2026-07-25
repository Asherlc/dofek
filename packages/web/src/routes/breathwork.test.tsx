/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Technique {
  id: string;
  name: string;
  description: string;
  inhaleSeconds: number;
  exhaleSeconds: number;
  defaultRounds: number;
}

interface Session {
  id: string;
  techniqueId: string;
  rounds: number;
  durationSeconds: number;
  startedAt: string;
}

interface QueryState<T> {
  data: T | undefined;
  isLoading: boolean;
  error: Error | null;
}

interface LogSessionInput {
  techniqueId: string;
  rounds: number;
  durationSeconds: number;
  startedAt: string;
}

interface TestState {
  capturedComponent: ComponentType | null;
  techniques: QueryState<Technique[]>;
  history: QueryState<Session[]>;
  mutationError: Error | null;
  mutationFailure: Error | null;
  mutationPending: boolean;
  mutationInput: LogSessionInput | null;
  captureException: ReturnType<typeof vi.fn>;
  invalidateHistory: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted<TestState>(() => ({
  capturedComponent: null,
  techniques: { data: [], isLoading: false, error: null },
  history: { data: [], isLoading: false, error: null },
  mutationError: null,
  mutationFailure: null,
  mutationPending: false,
  mutationInput: null,
  captureException: vi.fn(),
  invalidateHistory: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: { component: ComponentType }) => {
    state.capturedComponent = options.component;
    return {};
  },
}));

vi.mock("../components/PageLayout.tsx", () => ({
  PageLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock("../lib/telemetry.ts", () => ({
  captureException: state.captureException,
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    breathwork: {
      techniques: { useQuery: () => state.techniques },
      history: { useQuery: () => state.history },
      logSession: {
        useMutation: (options: { onSuccess?: () => void; onError?: (error: Error) => void }) => ({
          mutate: (input: LogSessionInput) => {
            state.mutationInput = input;
            if (state.mutationFailure) {
              state.mutationError = state.mutationFailure;
              options.onError?.(state.mutationFailure);
              return;
            }
            state.mutationError = null;
            options.onSuccess?.();
          },
          isPending: state.mutationPending,
          error: state.mutationError,
        }),
      },
    },
    useUtils: () => ({
      breathwork: { history: { invalidate: state.invalidateHistory } },
    }),
  },
}));

import "./breathwork.tsx";

function renderBreathworkPage() {
  if (!state.capturedComponent) throw new Error("Breathwork route component was not captured");
  const BreathworkPage = state.capturedComponent;
  return render(<BreathworkPage />);
}

describe("BreathworkPage", () => {
  beforeEach(() => {
    state.techniques = { data: [], isLoading: false, error: null };
    state.history = { data: [], isLoading: false, error: null };
    state.mutationError = null;
    state.mutationFailure = null;
    state.mutationPending = false;
    state.mutationInput = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the techniques server error instead of a disabled empty selector", () => {
    state.techniques = {
      data: undefined,
      isLoading: false,
      error: new Error("Breathing techniques are unavailable."),
    };

    renderBreathworkPage();

    expect(screen.getByText("Breathing techniques are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Session" })).toBeNull();
  });

  it("shows the history server error instead of hiding recent sessions", () => {
    state.history = {
      data: undefined,
      isLoading: false,
      error: new Error("Breathwork history could not be loaded."),
    };

    renderBreathworkPage();

    expect(screen.getByText("Recent Sessions")).toBeTruthy();
    expect(screen.getByText("Breathwork history could not be loaded.")).toBeTruthy();
  });

  it("shows explicit loading and empty states for techniques and history", () => {
    state.techniques = { data: undefined, isLoading: true, error: null };
    state.history = { data: undefined, isLoading: true, error: null };

    const { rerender } = renderBreathworkPage();

    expect(screen.getAllByTestId("query-state-loading")).toHaveLength(2);

    state.techniques = { data: [], isLoading: false, error: null };
    state.history = { data: [], isLoading: false, error: null };
    if (!state.capturedComponent) throw new Error("Breathwork route component was not captured");
    const BreathworkPage = state.capturedComponent;
    rerender(<BreathworkPage />);

    expect(screen.getByText("No breathwork techniques are available.")).toBeTruthy();
    expect(screen.getByText("No breathwork sessions logged yet.")).toBeTruthy();
  });

  it("preserves cached techniques while reporting a background refresh error", () => {
    state.techniques = {
      data: [
        {
          id: "box-breathing",
          name: "Box Breathing",
          description: "Calming pattern",
          inhaleSeconds: 1,
          exhaleSeconds: 1,
          defaultRounds: 1,
        },
      ],
      isLoading: false,
      error: new Error("Technique refresh failed."),
    };

    renderBreathworkPage();

    expect(screen.getAllByText("Box Breathing")).toHaveLength(2);
    expect(screen.getByText("Technique refresh failed.")).toBeTruthy();
  });

  it("preserves cached history while reporting a background refresh error", () => {
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
      },
    ];
    state.history = {
      data: [
        {
          id: "session-1",
          techniqueId: "box-breathing",
          rounds: 4,
          durationSeconds: 240,
          startedAt: "2026-07-24T12:00:00.000Z",
        },
      ],
      isLoading: false,
      error: new Error("History refresh failed."),
    };

    renderBreathworkPage();

    expect(screen.getByText("4 rounds / 4m")).toBeTruthy();
    expect(screen.getByText("History refresh failed.")).toBeTruthy();
  });

  it("reports a completed-session save failure and keeps a retry action", () => {
    vi.useFakeTimers();
    const saveError = new Error("Session could not be saved. Please retry.");
    state.mutationFailure = saveError;
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });

    expect(screen.getByText(saveError.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Save" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Session" })).toHaveProperty("disabled", true);
    expect(state.mutationInput).toMatchObject({
      techniqueId: "box-breathing",
      rounds: 1,
      durationSeconds: 2,
    });
    expect(state.captureException).toHaveBeenCalledWith(saveError, {
      context: "breathwork-log-session",
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry Save" }));
    expect(state.captureException).toHaveBeenCalledTimes(2);
  });

  it("clears the pending payload and refreshes history after a retry succeeds", () => {
    vi.useFakeTimers();
    state.mutationFailure = new Error("Session save failed.");
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });

    state.mutationFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry Save" }));

    expect(state.invalidateHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start Session" })).toHaveProperty("disabled", false);
  });
});
