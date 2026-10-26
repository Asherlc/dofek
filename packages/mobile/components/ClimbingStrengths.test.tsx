import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingStrengths } from "./ClimbingStrengths";
import { climbingStrengthsFixture as data } from "./climbing-strengths-fixtures";

const openExternalUrl = vi.hoisted(() => vi.fn().mockResolvedValue(true));
vi.mock("../lib/open-external-url", () => ({ openExternalUrl }));
const push = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({ useRouter: () => ({ push }) }));
describe("ClimbingStrengths", () => {
  it("renders server values and selects grade, dimension and context", () => {
    render(<ClimbingStrengths data={data} />);
    expect(screen.getByText("Same-grade baseline · 44% · 4/9 climbs sent")).toBeTruthy();
    expect(document.querySelector('[testID="strength-bar-slab"]')?.getAttribute("width")).toBe(
      "40%",
    );
    expect(document.querySelector('[testID="strength-baseline-slab"]')?.getAttribute("x")).toBe(
      "44%",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Slab · 40% · 2/5 climbs sent · -4 percentage points vs same-grade baseline",
      }),
    );
    expect(screen.getByText("Quiet Feet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View activity for Quiet Feet" }));
    expect(push).toHaveBeenCalledWith("/activity/activity-1");
    fireEvent.click(screen.getByRole("link", { name: "Mountain Project source for Quiet Feet" }));
    expect(openExternalUrl).toHaveBeenCalledWith(
      "https://www.mountainproject.com/route/1",
      "climbing-strengths-source",
    );
    fireEvent.click(screen.getByRole("button", { name: "V4" }));
    expect(screen.getByText("Same-grade baseline · 20% · 1/5 climbs sent")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Slab · 0% · 0/2 climbs sent · Limited data · -20 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Vertical · 33% · 1/3 climbs sent · Limited data · +13 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hold type" }));
    expect(
      screen.getByRole("button", {
        name: "Crimps · 0% · 0/2 climbs sent · Limited data · -20 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Routes · YDS · Lead · Free" }));
    expect(screen.getByRole("button", { name: "Outdoor" })).toBeTruthy();
  });
  it("uses setting observations when angle traits are missing and keeps the grade across dimensions", () => {
    const panels = data.panels.map((panel) =>
      panel.dimension === "setting" ? panel : { ...panel, rows: [] },
    );
    render(<ClimbingStrengths data={{ ...data, panels }} />);
    expect(
      screen.getByRole("button", { name: "Indoor / outdoor" }).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "V4" }));
    fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
    expect(screen.getByRole("button", { name: "V4" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("No recorded wall angle observations in this context.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Indoor / outdoor" }));
    expect(
      screen.getByRole("button", {
        name: "Indoor · 20% · 1/5 climbs sent · 0 percentage points vs same-grade baseline",
      }),
    ).toBeTruthy();
  });
  it("preserves the observed default Outdoor setting through the setting comparison", () => {
    const angle = data.panels[0];
    if (!angle) throw new Error("Missing fixture angle panel");
    const setting = data.panels.find((panel) => panel.dimension === "setting");
    if (!setting) throw new Error("Missing fixture setting panel");
    render(
      <ClimbingStrengths
        data={{
          ...data,
          panels: [
            { ...angle, rows: [] },
            { ...angle, key: "outdoor-angle", setting: "outdoor" },
            setting,
          ],
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Outdoor" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Indoor / outdoor" }));
    fireEvent.click(screen.getByRole("button", { name: "Wall angle" }));
    expect(screen.getByRole("button", { name: "Outdoor" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
  it("keeps navigation available through an unknown-only context", () => {
    const panels = data.panels.map((panel) =>
      panel.contextKey === "route-yds-lead"
        ? { ...panel, grades: [], rows: [], coverage: { missingTraits: 0, unknownOutcomes: 3 } }
        : panel,
    );
    render(<ClimbingStrengths data={{ ...data, panels }} />);
    expect(screen.getByText("Same-grade baseline · 44% · 4/9 climbs sent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Routes · YDS · Lead · Free" }));
    expect(screen.getByRole("button", { name: "Bouldering · V scale · Free" })).toBeTruthy();
    expect(screen.getByText("No recorded climbing outcomes in this context")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Coverage details" }));
    expect(screen.getByText("Unknown outcomes in this context: 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Bouldering · V scale · Free" }));
    expect(screen.getByText("Same-grade baseline · 44% · 4/9 climbs sent")).toBeTruthy();
    expect(screen.getByText("Unknown outcomes in this context: 2")).toBeTruthy();
  });
  it("discloses coverage and distinguishes no data", () => {
    render(<ClimbingStrengths data={data} />);
    expect(screen.getByRole("button", { name: "Vertical · No data" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Coverage details" }));
    expect(screen.getByText("Missing traits: 7")).toBeTruthy();
    expect(screen.getByText("Unknown outcomes: 3")).toBeTruthy();
    expect(screen.getByText("Records with missing or conflicting grades: 2")).toBeTruthy();
    expect(screen.getByText("Unidentified records: 1")).toBeTruthy();
  });
  it("separates loading, errors, empty and cached refresh", () => {
    const view = render(<ClimbingStrengths data={undefined} loading />);
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(
      <ClimbingStrengths data={undefined} error={{ message: "Reconnect your account." }} />,
    );
    expect(screen.getByText("Reconnect your account.")).toBeTruthy();
    expect(screen.queryByTestId("query-state-empty")).toBeNull();
    view.rerender(<ClimbingStrengths data={{ panels: [], coverage: data.coverage }} />);
    expect(screen.getByText("No recorded climbing outcomes in this period")).toBeTruthy();
    view.rerender(
      <ClimbingStrengths data={data} loading error={{ message: "Reconnect your account." }} />,
    );
    expect(screen.getByText("Same-grade baseline · 44% · 4/9 climbs sent")).toBeTruthy();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });
});
