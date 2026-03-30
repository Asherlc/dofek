import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkeletonCard, SkeletonCircle, SkeletonRect } from "./Skeleton";

describe("Skeleton components", () => {
  it("renders SkeletonCircle with given size", () => {
    render(<SkeletonCircle size={100} />);
    expect(screen.getByTestId("skeleton-circle")).toBeTruthy();
  });

  it("renders SkeletonRect with given dimensions", () => {
    render(<SkeletonRect width={200} height={20} />);
    expect(screen.getByTestId("skeleton-rect")).toBeTruthy();
  });

  it("renders SkeletonCard", () => {
    render(<SkeletonCard />);
    expect(screen.getByTestId("skeleton-card")).toBeTruthy();
  });
});
