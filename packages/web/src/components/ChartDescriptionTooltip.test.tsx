// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartDescriptionTooltip } from "./ChartDescriptionTooltip.tsx";

describe("ChartDescriptionTooltip", () => {
  it("opens and explicitly closes a labeled chart explanation", async () => {
    render(<ChartDescriptionTooltip description="This chart shows your weekly training load." />);

    const trigger = screen.getByRole("button", { name: "About this chart" });
    expect(trigger).toHaveTextContent("About");
    expect(trigger).toHaveClass("min-h-11", "min-w-11", "focus-visible:ring-2");
    expect(screen.queryByRole("dialog")).toBeNull();

    trigger.focus();
    fireEvent.click(trigger);

    const dialog = screen.getByRole("dialog", {
      name: "About this chart",
      description: "This chart shows your weekly training load.",
    });
    const descriptionId = dialog.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    expect(document.getElementById(descriptionId ?? "")).toHaveTextContent(
      "This chart shows your weekly training load.",
    );
    expect(screen.getByText("This chart shows your weekly training load.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close chart explanation" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(trigger).toHaveFocus();
    });
  });

  it("applies custom classes", () => {
    render(<ChartDescriptionTooltip description="Chart info" className="my-custom-class" />);

    const trigger = screen.getByRole("button", { name: "About this chart" });
    expect(trigger.closest(".my-custom-class")).toBeTruthy();
  });

  it("dismisses the explanation with Escape", async () => {
    render(<ChartDescriptionTooltip description="Chart info" />);

    const trigger = screen.getByRole("button", { name: "About this chart" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("dismisses the explanation with an outside interaction", async () => {
    render(<ChartDescriptionTooltip description="Chart info" />);

    const trigger = screen.getByRole("button", { name: "About this chart" });
    fireEvent.click(trigger);
    const overlay = document.querySelector("[data-state='open'][aria-hidden='true']");
    if (!(overlay instanceof HTMLElement)) throw new Error("Expected the dialog overlay");
    await waitFor(() => {
      fireEvent.pointerDown(overlay, { button: 1 });
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });
});
