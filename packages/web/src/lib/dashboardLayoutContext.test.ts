import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DashboardLayoutContext,
  DEFAULT_LAYOUT,
  SECTION_LABELS,
  useDashboardLayout,
} from "./dashboardLayoutContext.ts";

describe("DEFAULT_LAYOUT", () => {
  it("has a non-empty order array", () => {
    expect(DEFAULT_LAYOUT.order.length).toBeGreaterThan(0);
  });

  it("starts with healthMonitor", () => {
    expect(DEFAULT_LAYOUT.order[0]).toBe("healthMonitor");
  });

  it("has empty hidden array by default", () => {
    expect(DEFAULT_LAYOUT.hidden).toEqual([]);
  });

  it("has bodyComp collapsed by default", () => {
    expect(DEFAULT_LAYOUT.collapsed.bodyComp).toBe(true);
  });
});

describe("SECTION_LABELS", () => {
  it("has a label for every section in the default order", () => {
    for (const section of DEFAULT_LAYOUT.order) {
      expect(SECTION_LABELS[section]).toBeDefined();
      expect(typeof SECTION_LABELS[section]).toBe("string");
    }
  });

  it("has human-readable labels (no acronyms)", () => {
    for (const label of Object.values(SECTION_LABELS)) {
      expect(label.length).toBeGreaterThan(2);
    }
    expect(SECTION_LABELS.spo2Temp).toBe("Blood Oxygen Saturation & Skin Temperature");
  });
});

describe("DashboardLayoutContext", () => {
  it("exports a React context", () => {
    expect(DashboardLayoutContext).toBeDefined();
  });

  it("useDashboardLayout returns the nearest dashboard layout context value", () => {
    const setOrder = () => {};
    const toggleHidden = () => {};
    const toggleCollapsed = () => {};
    const moveSection = () => {};
    const resetLayout = () => {};
    const contextValue = {
      layout: {
        order: ["sleep"],
        hidden: ["nutrition"],
        collapsed: { bodyComp: false },
      },
      setOrder,
      toggleHidden,
      toggleCollapsed,
      moveSection,
      resetLayout,
    };
    let capturedContextValue: unknown = null;
    const Consumer = () => {
      capturedContextValue = useDashboardLayout();
      return null;
    };

    renderToString(
      createElement(
        DashboardLayoutContext.Provider,
        { value: contextValue },
        createElement(Consumer),
      ),
    );

    expect(capturedContextValue).toBe(contextValue);
  });
});
