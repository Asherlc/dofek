import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RouteMap } from "./RouteMap";

const gpsPoints = [
  { lat: 40.748, lng: -73.985 },
  { lat: 40.749, lng: -73.984 },
  { lat: 40.75, lng: -73.983 },
  { lat: 40.751, lng: -73.982 },
];

describe("RouteMap", () => {
  it("renders the map when given GPS points", () => {
    render(<RouteMap points={gpsPoints} />);
    expect(screen.getByText("Route Map")).toBeTruthy();
  });

  it("renders nothing when given an empty array", () => {
    const { container } = render(<RouteMap points={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("filters out points without coordinates", () => {
    const mixedPoints = [
      { lat: null, lng: null },
      { lat: 40.748, lng: -73.985 },
      { lat: null, lng: -73.984 },
      { lat: 40.75, lng: -73.983 },
    ];
    render(<RouteMap points={mixedPoints} />);
    expect(screen.getByText("Route Map")).toBeTruthy();
  });

  it("renders nothing when all points lack coordinates", () => {
    const { container } = render(
      <RouteMap
        points={[
          { lat: null, lng: null },
          { lat: null, lng: null },
        ]}
      />,
    );
    expect(container.innerHTML).toBe("");
  });
});
