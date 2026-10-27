// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProviderFamilyCard } from "./ProviderFamilyCard.tsx";

describe("ProviderFamilyCard", () => {
  it("uses pressed buttons to switch the visible connection method", () => {
    render(
      <ProviderFamilyCard
        familyLabel="Garmin"
        methods={[
          { id: "garmin", label: "Garmin Connect", content: <div>Connect Garmin</div> },
          { id: "garmin-dump", label: "Data export", content: <div>Import Garmin export</div> },
        ]}
      />,
    );

    const exportButton = screen.getByRole("button", { name: "Data export" });
    expect(screen.getByRole("button", { name: "Garmin Connect" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(exportButton).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(exportButton);

    expect(exportButton).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText("Connect Garmin")).toBeNull();
    expect(screen.getByText("Import Garmin export")).toBeTruthy();
  });

  it("can initialize the alternate connection method for visual coverage", () => {
    render(
      <ProviderFamilyCard
        familyLabel="Garmin"
        initialMethodId="garmin-dump"
        methods={[
          { id: "garmin", label: "Garmin Connect", content: <div>Connect Garmin</div> },
          { id: "garmin-dump", label: "Data export", content: <div>Import Garmin export</div> },
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "Data export" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("Import Garmin export")).toBeTruthy();
  });
});
