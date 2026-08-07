import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duration } from "../../theme";
import { RecoveryRing } from "./RecoveryRing";

const mockWithTiming = vi.hoisted(() => vi.fn((toValue: unknown) => toValue));

vi.mock("react-native-reanimated", () => ({
  createAnimatedComponent: (component: unknown) => component,
  Easing: {
    bezier: vi.fn(() => "bezier"),
  },
  useAnimatedProps: (updater: () => Record<string, unknown>) => updater(),
  useSharedValue: (initial: unknown) => ({ value: initial }),
  withTiming: mockWithTiming,
}));

describe("RecoveryRing", () => {
  afterEach(() => {
    mockWithTiming.mockClear();
  });

  it("renders the score number", () => {
    render(<RecoveryRing score={72} />);
    expect(screen.getByText("72")).toBeTruthy();
  });

  it("rounds the score", () => {
    render(<RecoveryRing score={72.6} />);
    expect(screen.getByText("73")).toBeTruthy();
  });

  it("renders 'Recovered' label for high scores", () => {
    render(<RecoveryRing score={80} />);
    expect(screen.getByText("Recovered")).toBeTruthy();
  });

  it("renders 'Moderate' label for medium scores", () => {
    render(<RecoveryRing score={50} />);
    expect(screen.getByText("Moderate")).toBeTruthy();
  });

  it("renders 'Poor' label for low scores", () => {
    render(<RecoveryRing score={20} />);
    expect(screen.getByText("Poor")).toBeTruthy();
  });

  it("uses custom label when provided", () => {
    render(<RecoveryRing score={80} label="Custom" />);
    expect(screen.getByText("Custom")).toBeTruthy();
    expect(screen.queryByText("Recovered")).toBeNull();
  });

  it("animates the ring with the standard count-up duration", () => {
    render(<RecoveryRing score={72} />);

    expect(mockWithTiming).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ duration: duration.countUp }),
    );
  });
});
