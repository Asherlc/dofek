/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingEntryCard } from "./ClimbingEntryCard.tsx";

describe("ClimbingEntryCard", () => {
  it("visibly associates the selected overview occurrence with its card", () => {
    render(
      <ClimbingEntryCard
        entryId="repeat"
        name="Same climb"
        location={undefined}
        entryNumber={3}
        selected
      >
        <p>Same climb</p>
      </ClimbingEntryCard>,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent("Entry 3");
    expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
  });
  it("preserves a tick action without inventing GPS for a locationless tick", () => {
    const onAttach = vi.fn();
    render(
      <ClimbingEntryCard entryId="indoor" name="Board tick" location={undefined}>
        <p>Board tick</p>
        <button type="button" onClick={onAttach}>
          Attach
        </button>
      </ClimbingEntryCard>,
    );
    expect(screen.getByRole("listitem")).toHaveTextContent("Board tick");
    expect(screen.queryByRole("region")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attach" }));
    expect(onAttach).toHaveBeenCalledOnce();
  });

  it("identifies the owning area even when its source omitted the name", () => {
    render(
      <ClimbingEntryCard
        entryId="tick"
        name="Climb"
        location={{
          coordinates: { latitude: 0, longitude: 0 },
          scope: "area",
          objectId: "area-123",
          providerId: "openbeta",
          name: null,
        }}
      >
        <p>Climb</p>
      </ClimbingEntryCard>,
    );
    expect(screen.getByText("Area location: area-123 · OpenBeta")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Climbing locations" })).toBeInTheDocument();
  });
});
