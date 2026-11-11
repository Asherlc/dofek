// @vitest-environment jsdom
import { UnitConverter } from "@dofek/format/units";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouteComparisonCard } from "./RouteComparisonCard";
import { routeComparisonFixture } from "./route-comparison-fixtures";

const state = vi.hoisted<{
  data: unknown;
  isLoading: boolean;
  isFetching: boolean;
  error: Error | null;
}>(() => ({
  data: undefined,
  isLoading: false,
  isFetching: false,
  error: null,
}));
const push = vi.hoisted(() => vi.fn());
const query = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
vi.mock("../lib/units", () => ({ useUnitConverter: () => new UnitConverter("metric") }));
vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
vi.mock("../lib/trpc", () => ({ trpc: { hiking: { activityComparison: { useQuery: query } } } }));

import { captureException } from "../lib/telemetry";

beforeEach(() => {
  Object.assign(state, { data: undefined, isLoading: false, isFetching: false, error: null });
  query.mockImplementation(() => state);
  vi.clearAllMocks();
});
afterEach(cleanup);

it("distinguishes loading, empty, and actionable errors", () => {
  state.isLoading = true;
  const { rerender } = render(<RouteComparisonCard days={30} enabled />);
  expect(screen.getByTestId("query-state-loading")).toBeTruthy();
  Object.assign(state, { isLoading: false, data: [] });
  rerender(<RouteComparisonCard days={30} enabled />);
  expect(screen.getByText("No repeated GPS routes in this period")).toBeTruthy();
  Object.assign(state, { data: undefined, error: new Error("Reconnect your activity provider") });
  rerender(<RouteComparisonCard days={30} enabled />);
  expect(screen.getByText("Reconnect your activity provider")).toBeTruthy();
  expect(captureException).toHaveBeenCalledWith(state.error);
});

it("retains cached comparison during refreshing and refresh errors with activity navigation", () => {
  Object.assign(state, {
    data: routeComparisonFixture,
    isLoading: true,
    isFetching: true,
    error: new Error("Route refresh unavailable"),
  });
  render(<RouteComparisonCard days={90} enabled />);
  expect(screen.queryByTestId("query-state-loading")).toBeNull();
  expect(screen.getByText("Updating route comparison…")).toBeTruthy();
  expect(screen.getByText("Route refresh unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View Route comparison data" }));
  fireEvent.click(screen.getByRole("button", { name: /Morning river run:/ }));
  expect(push).toHaveBeenCalledWith("/activity/22222222-2222-4222-8222-222222222222");
  const options = query.mock.calls.at(-1)?.[1];
  expect(options.placeholderData(routeComparisonFixture)).toBe(routeComparisonFixture);
  expect(query.mock.calls.at(-1)?.[0]).toEqual({ days: 90 });
});
