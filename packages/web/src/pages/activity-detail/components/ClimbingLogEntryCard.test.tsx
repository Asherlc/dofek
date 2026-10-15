/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryCard } from "./ClimbingLogEntryCard.tsx";

it.each([undefined, 3])(
  "identifies its Attach action and announces pending state for entry number %s",
  (entryNumber) => {
    const entry = climbingLogEntryFixture({ climb: climbingClimbFixture() });
    const onAttach = vi.fn();
    const name =
      entryNumber == null
        ? "Attach Corner to this activity"
        : "Attach entry 3, Corner to this activity";
    const view = render(
      <ul>
        <ClimbingLogEntryCard
          entry={entry}
          entryNumber={entryNumber}
          onAttach={onAttach}
          attachmentState={{ pending: false, error: null }}
        />
      </ul>,
    );
    const button = screen.getByRole("button", { name });
    expect(button).toHaveAttribute("aria-busy", "false");
    fireEvent.click(button);
    expect(onAttach).toHaveBeenCalledWith(entry.id);
    view.rerender(
      <ul>
        <ClimbingLogEntryCard
          entry={entry}
          entryNumber={entryNumber}
          onAttach={onAttach}
          attachmentState={{ pending: true, error: null }}
        />
      </ul>,
    );
    expect(screen.getByRole("button", { name })).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name })).toBeDisabled();
    expect(screen.getByRole("button", { name })).toHaveTextContent("Attaching...");
  },
);

it("keeps canonical source links and independent recorded facts accessible without GPS", () => {
  const entry = climbingLogEntryFixture({
    climb: climbingClimbFixture(),
    sourceName: "OpenBeta",
    sourceLinks: [{ providerId: "openbeta", kind: "route", url: "https://openbeta.io/" }],
  });
  const onAttach = vi.fn();
  render(
    <ul>
      <ClimbingLogEntryCard entry={entry} entryNumber={3} selected onAttach={onAttach} />
    </ul>,
  );
  expect(screen.getByRole("listitem")).toHaveTextContent("Entry 3 · Selected");
  expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("link", { name: "Corner on OpenBeta" })).toHaveAttribute(
    "href",
    "https://openbeta.io/",
  );
  fireEvent.click(screen.getByRole("button", { name: "Details for Corner" }));
  expect(screen.getByText("Published climb grades")).toBeInTheDocument();
  expect(screen.getByText("5.10a (Yosemite Decimal System)")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Attach entry 3, Corner to this activity" }));
  expect(onAttach).toHaveBeenCalledWith(entry.id);
});

it("identifies the owning area even when its source omitted the name", () => {
  render(
    <ul>
      <ClimbingLogEntryCard
        entry={climbingLogEntryFixture()}
        location={{
          coordinates: { latitude: 0, longitude: 0 },
          scope: "area",
          objectId: "area-123",
          providerId: "openbeta",
          name: null,
        }}
      />
    </ul>,
  );
  expect(screen.getByText("Area location: area-123 · OpenBeta")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Climbing locations" })).toBeInTheDocument();
});
