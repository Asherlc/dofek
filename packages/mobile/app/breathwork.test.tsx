// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface Technique {
  id: string;
  name: string;
  description: string;
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

const mocks = vi.hoisted<{
  mutate: ReturnType<typeof vi.fn>;
  techniques: {
    data: Technique[] | undefined;
    error: Error | null;
    isLoading: boolean;
  };
}>(() => ({
  mutate: vi.fn(),
  techniques: {
    data: [],
    error: null,
    isLoading: false,
  },
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    breathwork: {
      techniques: { useQuery: () => mocks.techniques },
      logSession: {
        useMutation: () => ({
          error: null,
          isPending: false,
          mutate: mocks.mutate,
        }),
      },
    },
  },
}));

describe("BreathworkScreen", () => {
  beforeEach(() => {
    mocks.techniques = {
      data: [
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
        },
        {
          id: "wim-hof",
          name: "Wim Hof Method",
          description: "Deep inhales, passive exhales, then a breath hold.",
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
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows calibrated benefits and safety before Start", async () => {
    const { default: BreathworkScreen } = await import("./breathwork");
    render(<BreathworkScreen />);

    expect(screen.getByText("Regular practice may support a more positive mood.")).toBeTruthy();
    expect(screen.getByText("Safety before you start")).toBeTruthy();
    expect(screen.getByText("Do not force or strain your breath.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start Session" })).toBeTruthy();
  });

  it("shows material Wim Hof warnings before Start", async () => {
    const { default: BreathworkScreen } = await import("./breathwork");
    render(<BreathworkScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Wim Hof Method" }));

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

  it("guides and logs a completed session", async () => {
    vi.useFakeTimers();
    const technique = mocks.techniques.data?.[0];
    if (!technique) throw new Error("Expected a breathwork technique fixture");
    mocks.techniques.data = [
      {
        ...technique,
        inhaleSeconds: 1,
        exhaleSeconds: 1,
        defaultRounds: 1,
      },
    ];
    const { default: BreathworkScreen } = await import("./breathwork");
    render(<BreathworkScreen />);

    fireEvent.click(screen.getByRole("button", { name: "Start Session" }));

    expect(screen.getByText("Round 1 of 1")).toBeTruthy();
    expect(screen.getByText("Breathe In")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(2_100);
    });

    expect(mocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        techniqueId: "box-breathing",
        rounds: 1,
        durationSeconds: 2,
      }),
    );
  });

  it("shows the server error instead of an empty selector", async () => {
    mocks.techniques = {
      data: undefined,
      error: new Error("Breathing techniques are unavailable."),
      isLoading: false,
    };
    const { default: BreathworkScreen } = await import("./breathwork");
    render(<BreathworkScreen />);

    expect(screen.getByText("Breathing techniques are unavailable.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start Session" })).toBeNull();
  });
});
