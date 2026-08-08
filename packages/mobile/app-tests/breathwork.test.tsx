// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Technique {
  id: string;
  name: string;
  purpose?: string;
  description: string;
  possibleBenefit?: string;
  difficulty?: string;
  durationSeconds?: number;
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

const mocks = vi.hoisted<{
  mutate: ReturnType<typeof vi.fn>;
  invalidateHistory: ReturnType<typeof vi.fn>;
  invalidateOutcomes: ReturnType<typeof vi.fn>;
  techniques: {
    data: Technique[] | undefined;
    error: Error | null;
    isLoading: boolean;
  };
  outcomes: {
    data:
      | {
          windowDays: number;
          windowKind: "rolling-instant";
          techniques: {
            techniqueId: string;
            sessionCount: number;
            stress: {
              reportCount: number;
              lowerCount: number;
              sameCount: number;
              higherCount: number;
            };
            perceivedEffect: {
              reportCount: number;
              betterCount: number;
              sameCount: number;
              worseCount: number;
            };
            dizziness: { reportCount: number; yesCount: number };
          }[];
        }
      | undefined;
    error: Error | null;
    isLoading: boolean;
  };
}>(() => ({
  mutate: vi.fn(),
  invalidateHistory: vi.fn(),
  invalidateOutcomes: vi.fn(),
  techniques: {
    data: [],
    error: null,
    isLoading: false,
  },
  outcomes: {
    data: { windowDays: 30, windowKind: "rolling-instant", techniques: [] },
    error: null,
    isLoading: false,
  },
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    breathwork: {
      techniques: { useQuery: () => mocks.techniques },
      outcomes: { useQuery: () => mocks.outcomes },
      logSession: {
        useMutation: (options: { onSuccess?: () => void }) => ({
          error: null,
          isPending: false,
          mutate: (input: unknown) => {
            mocks.mutate(input);
            options.onSuccess?.();
          },
        }),
      },
    },
    useUtils: () => ({
      breathwork: {
        history: { invalidate: mocks.invalidateHistory },
        outcomes: { invalidate: mocks.invalidateOutcomes },
      },
    }),
  },
}));

describe("BreathworkScreen", () => {
  beforeEach(() => {
    mocks.techniques = {
      data: [
        {
          id: "box-breathing",
          name: "Box Breathing",
          purpose: "Calm focus",
          description: "Equal-length inhale, hold, exhale, and hold phases.",
          possibleBenefit: "Regular practice may support a more positive mood.",
          difficulty: "Beginner",
          durationSeconds: 64,
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
        },
        {
          id: "wim-hof",
          name: "Power Breathing",
          purpose: "An energizing practice",
          description: "30 rounds of 2-second inhales followed by 2-second exhales.",
          difficulty: "Advanced",
          durationSeconds: 120,
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
        },
      ],
      error: null,
      isLoading: false,
    };
    mocks.outcomes = {
      data: { windowDays: 30, windowKind: "rolling-instant", techniques: [] },
      error: null,
      isLoading: false,
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows calibrated benefits and safety before Start", async () => {
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    expect(screen.getByText("Regular practice may support a more positive mood.")).toBeTruthy();
    expect(screen.getByText("Safety before you start")).toBeTruthy();
    expect(screen.getByText("Do not force or strain your breath.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Session" })).toBeTruthy();
  });

  it("shows duration and difficulty and exposes the full description to assistive tech", async () => {
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    expect(screen.getByText("Calm focus")).toBeTruthy();
    expect(screen.getByText(/Duration: 1m/)).toBeTruthy();
    expect(screen.getByText(/Difficulty: Beginner/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Box Breathing.*Calm focus.*Equal-length inhale, hold, exhale, and hold phases\..*Duration: 1m.*Difficulty: Beginner/,
      }),
    ).toBeTruthy();
  });

  it("shows material power breathing warnings before Start", async () => {
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    fireEvent.click(screen.getByRole("button", { name: /^Power Breathing/ }));

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

  it("guides a completed session at phase boundaries without polling", async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const technique = mocks.techniques.data?.[0];
    if (!technique) throw new Error("Expected a breathwork technique fixture");
    mocks.techniques.data = [
      {
        ...technique,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));

    expect(screen.getByText("Round 1 of 1")).toBeTruthy();
    expect(screen.getByText("Breathe In")).toBeTruthy();
    expect(setIntervalSpy).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(screen.getByText("Breathe In")).toBeTruthy();
    expect(mocks.mutate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Breathe Out")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(mocks.mutate).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(screen.getByText("How do you feel now?")).toBeTruthy();
    expect(screen.getByRole("button", { name: /^Box Breathing/ })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));
    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        techniqueId: "box-breathing",
        rounds: 1,
        durationSeconds: 2,
        stressBefore: null,
        stressAfter: null,
        dizzinessAfter: null,
        perceivedEffect: null,
      }),
    );
    expect(mocks.invalidateHistory).toHaveBeenCalledOnce();
    expect(mocks.invalidateOutcomes).toHaveBeenCalledOnce();
  });

  it("saves optional before-and-after reports", async () => {
    vi.useFakeTimers();
    const technique = mocks.techniques.data?.[0];
    if (!technique) throw new Error("Expected a breathwork technique fixture");
    mocks.techniques.data = [
      {
        ...technique,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Before-session stress 8" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "After-session stress 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Felt better" }));
    fireEvent.click(screen.getByRole("button", { name: "No dizziness" }));
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        techniqueId: "box-breathing",
        stressBefore: 8,
        stressAfter: 3,
        dizzinessAfter: false,
        perceivedEffect: "better",
      }),
    );
  });

  it("preserves a pre-session stress report when the post-session check-in is skipped", async () => {
    vi.useFakeTimers();
    const technique = mocks.techniques.data?.[0];
    if (!technique) throw new Error("Expected a breathwork technique fixture");
    mocks.techniques.data = [
      {
        ...technique,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Before-session stress 7" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        stressBefore: 7,
        stressAfter: null,
        dizzinessAfter: null,
        perceivedEffect: null,
      }),
    );
  });

  it("shows server-computed personal patterns without causal claims", async () => {
    mocks.outcomes.data = {
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
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

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
  });

  it("starts only one timer for rapid duplicate Start presses", async () => {
    vi.useFakeTimers();
    const technique = mocks.techniques.data?.[0];
    if (!technique) throw new Error("Expected a breathwork technique fixture");
    mocks.techniques.data = [
      {
        ...technique,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
        durationSeconds: 2,
      },
    ];
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);
    const startButton = screen.getByRole("button", { name: "Start Session" });

    act(() => {
      startButton.click();
      startButton.click();
    });
    act(() => {
      vi.advanceTimersByTime(4_000);
    });

    fireEvent.click(screen.getByRole("button", { name: "Skip check-in and save" }));
    expect(mocks.mutate).toHaveBeenCalledTimes(1);
  });

  it("shows the server error instead of an empty selector", async () => {
    mocks.techniques = {
      data: undefined,
      error: new Error("Breathing techniques are unavailable."),
      isLoading: false,
    };
    const { default: BreathworkScreen } = await import("../app/breathwork");
    render(<BreathworkScreen />);

    expect(screen.getByText("Breathing techniques are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Session" })).toBeNull();
  });
});
