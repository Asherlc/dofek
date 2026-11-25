import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  Comparison,
  FirstVisit,
  Loading,
  MapNameError,
  MapNames,
  RequestError,
} from "./GhostSessions.stories";

vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@react-native-community/slider", () => ({ default: () => null }));
vi.mock("./RouteMap", () => ({ RouteMap: () => null }));

it("pages the comparison story through the actual tRPC infinite query transport", async () => {
  render(<Comparison.render />);
  expect(await screen.findByText("20s faster")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Past efforts" }));
  expect(await screen.findByRole("button", { name: /Compare.*5m 20s/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Load more past efforts" }));
  fireEvent.click(await screen.findByRole("button", { name: /Compare.*4m 50s/ }));
  expect(await screen.findByText("10s slower")).toBeTruthy();
});

it.each([
  [Loading.render, "Preparing recorded route comparisons…"],
  [FirstVisit.render, "First recorded visit"],
  [RequestError.render, "Ghost Sessions could not be loaded."],
  [MapNames.render, "Cedar Road"],
  [MapNameError.render, "Road and trail names are temporarily unavailable."],
])("renders the expected state of a Ghost Sessions review fixture", async (StoryView, text) => {
  render(<StoryView />);
  expect(await screen.findByText(text)).toBeTruthy();
});
