/** @vitest-environment jsdom */

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Technique {
  id: string;
  name: string;
  purpose?: string;
  description: string;
  difficulty?: string;
  durationSeconds?: number;
  possibleBenefit?: string;
  safety: {
    position: string;
    warnings: string[];
    stopCriteria: string;
    emergency: string;
  };
  inhaleSeconds: number;
  exhaleSeconds: number;
  defaultRounds: number;
}

interface Session {
  id: string;
  techniqueId: string;
  techniqueLabel?: string;
  rounds: number;
  durationSeconds: number;
  startedAt: string;
  stressBefore?: number | null;
  stressAfter?: number | null;
  dizzinessAfter?: boolean | null;
  perceivedEffect?: "better" | "same" | "worse" | null;
}

interface OutcomeSummary {
  windowDays: number;
  windowKind: "rolling-instant";
  techniques: {
    techniqueId: string;
    sessionCount: number;
    stress: { reportCount: number; lowerCount: number; sameCount: number; higherCount: number };
    perceivedEffect: {
      reportCount: number;
      betterCount: number;
      sameCount: number;
      worseCount: number;
    };
    dizziness: { reportCount: number; yesCount: number };
  }[];
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
  stressBefore: number | null;
  stressAfter: number | null;
  dizzinessAfter: boolean | null;
  perceivedEffect: "better" | "same" | "worse" | null;
}

interface TestState {
  capturedComponent: ComponentType | null;
  techniques: QueryState<Technique[]>;
  history: QueryState<Session[]>;
  outcomes: QueryState<OutcomeSummary>;
  mutationError: Error | null;
  mutationFailure: Error | null;
  mutationPending: boolean;
  mutationInput: LogSessionInput | null;
  captureException: ReturnType<typeof vi.fn>;
  invalidateHistory: ReturnType<typeof vi.fn>;
  invalidateOutcomes: ReturnType<typeof vi.fn>;
}

const state = vi.hoisted<TestState>(() => ({
  capturedComponent: null,
  techniques: { data: [], isLoading: false, error: null },
  history: { data: [], isLoading: false, error: null },
  outcomes: {
    data: { windowDays: 30, windowKind: "rolling-instant", techniques: [] },
    isLoading: false,
    error: null,
  },
  mutationError: null,
  mutationFailure: null,
  mutationPending: false,
  mutationInput: null,
  captureException: vi.fn(),
  invalidateHistory: vi.fn(),
  invalidateOutcomes: vi.fn(),
}));

const standardSafety = {
  position: "Practice seated or lying down in a comfortable, safe place.",
  warnings: ["Do not force or strain your breath."],
  stopCriteria: "Stop and return to normal breathing if you feel dizzy or lightheaded.",
  emergency:
    "Call emergency services if someone faints and is not breathing, cannot be woken within 1 minute, or has not fully recovered.",
};

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
      outcomes: { useQuery: () => state.outcomes },
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
      breathwork: {
        history: { invalidate: state.invalidateHistory },
        outcomes: { invalidate: state.invalidateOutcomes },
      },
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
    state.outcomes = {
      data: { windowDays: 30, windowKind: "rolling-instant", techniques: [] },
      isLoading: false,
      error: null,
    };
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
          safety: standardSafety,
          inhaleSeconds: 1,
          exhaleSeconds: 1,
          defaultRounds: 1,
          durationSeconds: 2,
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
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
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

  it("shows material safety guidance before starting power breathing", () => {
    state.techniques.data = [
      {
        id: "wim-hof",
        name: "Power Breathing",
        description: "30 rounds of 2-second inhales followed by 2-second exhales.",
        safety: {
          position: "Practice only while seated or lying down in a safe place.",
          warnings: [
            "Intense rounds can, in rare cases, cause loss of consciousness.",
            "Never practice in or near water, while driving, or anywhere fainting could cause injury.",
          ],
          stopCriteria: "Stop and return to normal breathing if you feel dizzy or lightheaded.",
          emergency:
            "Call emergency services if someone faints and is not breathing, cannot be woken within 1 minute, or has not fully recovered.",
        },
        inhaleSeconds: 2,
        exhaleSeconds: 2,
        defaultRounds: 30,
        durationSeconds: 120,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Power Breathing/,
      }),
    );

    expect(screen.getByRole("heading", { name: "Safety before you start" })).toBeTruthy();
    expect(
      screen.getByText("Intense rounds can, in rare cases, cause loss of consciousness."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Never practice in or near water, while driving, or anywhere fainting could cause injury.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("Practice only while seated or lying down in a safe place."),
    ).toBeTruthy();
    expect(
      screen.getByText("Stop and return to normal breathing if you feel dizzy or lightheaded."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Call emergency services if someone faints and is not breathing, cannot be woken within 1 minute, or has not fully recovered.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Session" })).toBeTruthy();
  });

  it("labels supported benefits as possible", () => {
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Equal-length inhale, hold, exhale, and hold phases.",
        possibleBenefit: "Regular practice may support a more positive mood.",
        safety: {
          position: "Practice seated or lying down in a comfortable, safe place.",
          warnings: ["Do not force or strain your breath."],
          stopCriteria: "Stop and return to normal breathing if you feel dizzy or lightheaded.",
          emergency:
            "Call emergency services if someone faints and is not breathing, cannot be woken within 1 minute, or has not fully recovered.",
        },
        inhaleSeconds: 4,
        exhaleSeconds: 4,
        defaultRounds: 4,
        durationSeconds: 32,
      },
    ];

    renderBreathworkPage();

    expect(screen.getByText("Regular practice may support a more positive mood.")).toBeTruthy();
  });

  it("shows decision-ready technique details and never exposes raw history IDs", () => {
    const fullDescription =
      "Breathe in for 4 seconds, hold for 4 seconds, breathe out for 4 seconds, then hold for 4 seconds.";
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        purpose: "Calm focus",
        description: fullDescription,
        difficulty: "Beginner",
        durationSeconds: 64,
        safety: standardSafety,
        inhaleSeconds: 4,
        exhaleSeconds: 4,
        defaultRounds: 4,
      },
    ];
    state.history.data = [
      {
        id: "session-legacy",
        techniqueId: "resonance",
        techniqueLabel: "Resonant Breathing",
        rounds: 4,
        durationSeconds: 240,
        startedAt: "2026-07-24T12:00:00.000Z",
      },
    ];

    renderBreathworkPage();

    expect(
      screen.getByRole("button", {
        name: new RegExp(
          `Box Breathing.*Calm focus.*${fullDescription}.*Duration: 1m.*Difficulty: Beginner`,
        ),
      }),
    ).toBeTruthy();
    expect(screen.getAllByText("Calm focus")).toHaveLength(2);
    expect(screen.getByText(/Duration: 1m/)).toBeTruthy();
    expect(screen.getByText(/Difficulty: Beginner/)).toBeTruthy();
    expect(screen.getByText("Resonant Breathing")).toBeTruthy();
    expect(screen.queryByText("resonance")).toBeNull();
  });

  it("paginates recent sessions", () => {
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];
    state.history.data = Array.from({ length: 21 }, (_, index) => ({
      id: `session-${index + 1}`,
      techniqueId: "box-breathing",
      rounds: index + 1,
      durationSeconds: 60,
      startedAt: "2026-07-24T12:00:00.000Z",
    }));

    renderBreathworkPage();

    expect(screen.getByText("1 rounds / 1m")).toBeTruthy();
    expect(screen.queryByText("21 rounds / 1m")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Next sessions page" }));

    expect(screen.queryByText("1 rounds / 1m")).toBeNull();
    expect(screen.getByText("21 rounds / 1m")).toBeTruthy();
  });

  it("collects optional before-and-after reports and saves them with the session", () => {
    vi.useFakeTimers();
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Before-session stress 8" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });

    expect(state.mutationInput).toBeNull();
    expect(screen.getByRole("heading", { name: "How do you feel now?" })).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Box Breathing/,
      }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "After-session stress 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Felt better" }));
    fireEvent.click(screen.getByRole("button", { name: "No dizziness" }));
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    expect(state.mutationInput).toMatchObject({
      techniqueId: "box-breathing",
      stressBefore: 8,
      stressAfter: 3,
      dizzinessAfter: false,
      perceivedEffect: "better",
    });
    expect(state.invalidateHistory).toHaveBeenCalledOnce();
    expect(state.invalidateOutcomes).toHaveBeenCalledOnce();
  });

  it("saves explicit nulls when the optional check-in is skipped", () => {
    vi.useFakeTimers();
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));

    expect(state.mutationInput).toMatchObject({
      stressBefore: null,
      stressAfter: null,
      dizzinessAfter: null,
      perceivedEffect: null,
    });
  });

  it("preserves a pre-session stress report when the post-session check-in is skipped", () => {
    vi.useFakeTimers();
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Before-session stress 7" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));

    expect(state.mutationInput).toMatchObject({
      stressBefore: 7,
      stressAfter: null,
      dizzinessAfter: null,
      perceivedEffect: null,
    });
  });

  it("shows server-computed personal patterns and raw reports without causal claims", () => {
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];
    state.outcomes.data = {
      windowDays: 30,
      windowKind: "rolling-instant",
      techniques: [
        {
          techniqueId: "box-breathing",
          sessionCount: 5,
          stress: { reportCount: 4, lowerCount: 3, sameCount: 1, higherCount: 0 },
          perceivedEffect: { reportCount: 5, betterCount: 4, sameCount: 1, worseCount: 0 },
          dizziness: { reportCount: 5, yesCount: 1 },
        },
      ],
    };
    state.history.data = [
      {
        id: "session-1",
        techniqueId: "box-breathing",
        rounds: 4,
        durationSeconds: 64,
        startedAt: "2026-07-24T12:00:00.000Z",
        stressBefore: 8,
        stressAfter: 3,
        dizzinessAfter: false,
        perceivedEffect: "better",
      },
    ];

    renderBreathworkPage();

    expect(
      screen.getByText("Stress after session: 3 lower, 1 same, 0 higher (4 paired check-ins)"),
    ).toBeTruthy();
    expect(
      screen.getByText("Overall feeling: 4 better, 1 same, 0 worse (5 responses)"),
    ).toBeTruthy();
    expect(screen.getByText("Dizziness: 1 of 5 responses")).toBeTruthy();
    expect(
      screen.getByText(
        "Patterns in your reports do not prove the breathing technique caused the change.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Stress 8 → 3 · Felt better · No dizziness")).toBeTruthy();
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
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));

    expect(screen.getByText(saveError.message)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Save" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "How do you feel now?" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Session" })).toBeNull();
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
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_100);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));

    state.mutationFailure = null;
    fireEvent.click(screen.getByRole("button", { name: "Retry Save" }));

    expect(state.invalidateHistory).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry Save" })).toBeNull();
    expect(screen.getByRole("button", { name: "Start Session" })).toHaveProperty("disabled", false);
  });

  it("saves at the exact configured duration without accumulated timer drift", () => {
    vi.useFakeTimers();
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 4,
        exhaleSeconds: 4,
        defaultRounds: 1,
        durationSeconds: 8,
      },
    ];

    renderBreathworkPage();
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(8_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));

    expect(state.mutationInput).toMatchObject({
      techniqueId: "box-breathing",
      rounds: 1,
      durationSeconds: 8,
    });
  });

  it("starts only one timer for rapid duplicate Start presses", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    state.techniques.data = [
      {
        id: "box-breathing",
        name: "Box Breathing",
        description: "Calming pattern",
        safety: standardSafety,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];

    renderBreathworkPage();
    const startButton = screen.getByRole("button", { name: "Start Session" });
    act(() => {
      startButton.click();
      startButton.click();
    });

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
