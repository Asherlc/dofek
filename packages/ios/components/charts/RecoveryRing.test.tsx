import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecoveryRing } from "./RecoveryRing";

describe("RecoveryRing", () => {
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
});
