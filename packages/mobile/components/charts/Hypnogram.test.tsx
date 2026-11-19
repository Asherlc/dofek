import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Hypnogram } from "./Hypnogram";

describe("Hypnogram", () => {
  it("exposes recorded seconds in interval boundaries and duration", () => {
    render(
      <Hypnogram
        data={[
          {
            stage: "awake",
            started_at: "2026-11-15T23:00:15",
            ended_at: "2026-11-15T23:01:30",
            duration_seconds: 75,
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View Sleep stages data" }));
    fireEvent.click(screen.getByRole("button", { name: /Awake:/ }));
    expect(screen.getByText("Awake · 11:00:15 PM – 11:01:30 PM · 1m 15s")).toBeDefined();
  });

  const stages = [
    {
      stage: "deep",
      started_at: "2026-11-15T23:00:00Z",
      ended_at: "2026-11-15T23:30:00Z",
      duration_seconds: 1800,
    },
    {
      stage: "awake",
      started_at: "2026-11-16T00:00:00Z",
      ended_at: "2026-11-16T00:02:00Z",
      duration_seconds: 120,
    },
    {
      stage: "rem",
      started_at: "2026-11-16T00:02:00Z",
      ended_at: "2026-11-16T01:00:00Z",
      duration_seconds: 3480,
    },
    {
      stage: "light",
      started_at: "2026-11-16T01:00:00Z",
      ended_at: "2026-11-16T02:00:00Z",
      duration_seconds: 3600,
    },
  ];
  it("draws proportional solid blocks in separate lanes with a blank gap", () => {
    const { container } = render(<Hypnogram data={stages} />);
    fireEvent(
      screen.getByTestId("sleep-stage-plot"),
      new CustomEvent("layout", { detail: { width: 400, height: 184 } }),
    );
    const blocks = Array.from(container.querySelectorAll("rect"));
    expect(blocks).toHaveLength(4);
    const [deep, awake, rem, light] = blocks;
    expect(Number(deep?.getAttribute("height"))).toBe(Number(awake?.getAttribute("height")));
    expect(Number(deep?.getAttribute("height"))).toBeLessThan(45);
    expect(Number(awake?.getAttribute("y"))).toBeLessThan(Number(rem?.getAttribute("y")));
    expect(Number(rem?.getAttribute("y"))).toBeLessThan(Number(light?.getAttribute("y")));
    expect(Number(light?.getAttribute("y"))).toBeLessThan(Number(deep?.getAttribute("y")));
    expect(Number(deep?.getAttribute("width")) / Number(awake?.getAttribute("width"))).toBeCloseTo(
      15,
    );
    expect(Number(awake?.getAttribute("x"))).toBeGreaterThan(
      Number(deep?.getAttribute("x")) + Number(deep?.getAttribute("width")),
    );
    expect(deep?.getAttribute("fill")).toBe("#5E35B1");
    expect(Number(deep?.getAttribute("opacity") ?? 1)).toBe(1);
    if (!awake) throw new Error("Awake block is missing");
    fireEvent.click(awake);
    expect(screen.getByText(/Awake.*2m/)).toBeDefined();
  });
  it("gives stage labels their own column so scaled text cannot cover the bars", () => {
    const { container } = render(<Hypnogram data={stages} />);
    fireEvent(
      screen.getByTestId("sleep-stage-plot"),
      new CustomEvent("layout", { detail: { width: 400, height: 184 } }),
    );

    const rects = Array.from(container.querySelectorAll("rect"));
    expect(rects.length).toBeGreaterThan(0);
    const firstBarX = Math.min(...rects.map((rect) => Number(rect.getAttribute("x") ?? NaN)));
    expect(firstBarX).toBeLessThan(10);

    const plot = screen.getByTestId("sleep-stage-plot");
    expect(plot.parentElement?.getAttribute("style")).toContain("flex");
    expect(plot.parentElement?.parentElement?.getAttribute("style")).toContain(
      "flex-direction: row",
    );

    const lane = container.querySelector("line");
    expect(Number(lane?.getAttribute("x2"))).toBe(400 - 12);
  });

  it("flows two-digit time anchors below the plot so enlarged text can wrap without covering the lanes", () => {
    render(
      <Hypnogram
        data={[
          {
            stage: "light",
            started_at: "2026-07-01T22:30:00",
            ended_at: "2026-07-02T09:30:00",
            duration_seconds: 39600,
          },
          {
            stage: "awake",
            started_at: "2026-07-02T09:30:00",
            ended_at: "2026-07-02T11:30:00",
            duration_seconds: 7200,
          },
        ]}
      />,
    );

    const plot = screen.getByTestId("sleep-stage-plot");
    const startLabel = screen.getByText("10:30 PM");
    const endLabel = screen.getByText("11:30 AM");

    // The anchors are siblings in a wrapping row below the measured plot, not
    // absolutely positioned over the bottom of the lane bars.
    expect(plot.contains(startLabel)).toBe(false);
    expect(plot.contains(endLabel)).toBe(false);
    expect(startLabel.parentElement).toBe(endLabel.parentElement);
    expect(startLabel.parentElement?.getAttribute("style")).toContain("flex-wrap: wrap");
    expect(startLabel.parentElement?.getAttribute("style")).not.toContain("position: absolute");
  });

  it("allows exact-value selection and clears it when the night changes", () => {
    const { rerender } = render(<Hypnogram data={stages} />);
    fireEvent.click(screen.getByRole("button", { name: "View Sleep stages data" }));
    fireEvent.click(screen.getByRole("button", { name: /Awake:/ }));
    expect(screen.getByText(/Awake.*2m/)).toBeDefined();
    rerender(<Hypnogram data={stages.slice(0, 1)} />);
    expect(screen.getByText(/Select a sleep stage/)).toBeDefined();
    expect(screen.getAllByText("Awake").length).toBeGreaterThan(0);
  });

  it("provides a VoiceOver summary and exact sleep-stage intervals", () => {
    render(
      <Hypnogram
        data={[
          {
            stage: "deep",
            started_at: "2026-07-01T22:00:00",
            ended_at: "2026-07-01T22:30:00",
            duration_seconds: 1800,
          },
          {
            stage: "rem",
            started_at: "2026-07-01T22:30:00",
            ended_at: "2026-07-01T23:00:00",
            duration_seconds: 1800,
          },
        ]}
      />,
    );

    expect(
      screen.getByRole("image", {
        name: "Sleep stages. Sleep stages over the recorded sleep period.",
      }),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View Sleep stages data" }));
    expect(screen.getAllByText("Deep").length).toBeGreaterThan(0);
    expect(screen.getByText(/10:00:00 PM to 10:30:00 PM/)).toBeDefined();
    expect(screen.getAllByText("REM").length).toBeGreaterThan(0);
    expect(screen.getByText(/10:30:00 PM to 11:00:00 PM/)).toBeDefined();
  });
});
