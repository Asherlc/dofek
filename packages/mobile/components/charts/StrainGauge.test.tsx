import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { duration } from "../../theme";
import { StrainGauge } from "./StrainGauge";

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

describe("StrainGauge", () => {
  afterEach(() => {
    mockWithTiming.mockClear();
  });

  it("renders the strain number", () => {
    render(<StrainGauge strain={12.4} />);

    expect(screen.getByText("12.4")).toBeTruthy();
  });

  it("animates the gauge with the standard count-up duration", () => {
    render(<StrainGauge strain={12.4} />);

    expect(mockWithTiming).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ duration: duration.countUp }),
    );
  });
});
