import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SkeletonCircle } from "./Skeleton";

describe("Skeleton components", () => {
  it("renders SkeletonCircle with given size", () => {
    render(<SkeletonCircle size={100} />);
    expect(screen.getByTestId("skeleton-circle")).toBeTruthy();
  });
});
