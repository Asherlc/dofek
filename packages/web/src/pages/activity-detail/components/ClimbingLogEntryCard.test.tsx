/** @vitest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryCard } from "./ClimbingLogEntryCard.tsx";

it("shows Mountain Project's recorded top-rope method with an unknown attempt count", () => {
  const climb = { ...climbingClimbFixture("mountain-project"), name: "Havarti Cheese" };
  const entry = climbingLogEntryFixture({
    providerId: "mountain-project",
    sourceName: "Mountain Project",
    climbId: climb.id,
    climb,
    recordedClimbAttemptCount: null,
    recordedClimbOutcome: null,
  });
  entry.attempts = [climbingAttemptFixture(entry.id, { ropeMethod: "top_rope" })];
  render(
    <ul>
      <ClimbingLogEntryCard entry={entry} />
    </ul>,
  );
  expect(screen.getByText("Havarti Cheese")).toBeInTheDocument();
  expect(screen.getByText("Top rope")).toBeInTheDocument();
  expect(screen.queryByText(/Attempts:/)).toBeNull();
});

it.each([
  { count: null, summary: "Completed" },
  { count: 2, summary: "Completed · Attempts: 2" },
])("shows the recorded result with attempt count $count", ({ count, summary }) => {
  const entry = climbingLogEntryFixture({
    recordedClimbAttemptCount: count,
    recordedClimbOutcome: "completed",
  });
  render(
    <ul>
      <ClimbingLogEntryCard entry={entry} />
    </ul>,
  );
  expect(screen.getByText(summary)).toBeInTheDocument();
});

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

it.each([
  { freeSend: false, outcome: "completed", summary: "Completed · Attempts: 2" },
  { freeSend: false, outcome: "failed", summary: "Attempted · Attempts: 2" },
  { freeSend: null, outcome: "completed", summary: "Completed · Attempts: 2" },
  { freeSend: true, outcome: "completed", summary: "Attempts: 2" },
  { freeSend: false, outcome: null, summary: "Attempts: 2" },
  { freeSend: null, outcome: null, summary: "Attempts: 2" },
] as const)(
  "renders the server's send status ($freeSend, $outcome)",
  ({ freeSend, outcome, summary }) => {
    const entry = climbingLogEntryFixture({
      freeSend,
      recordedClimbOutcome: outcome,
      recordedClimbAttemptCount: 2,
    });
    render(
      <ul>
        <ClimbingLogEntryCard entry={entry} />
      </ul>,
    );
    expect(screen.getByText(summary)).toBeInTheDocument();
    expect(screen.queryAllByText(/Attempted/)).toHaveLength(outcome === "failed" ? 1 : 0);
  },
);

it("keeps canonical source links and attachment actions accessible without GPS", () => {
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
  expect(screen.getByRole("listitem")).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("link", { name: "Corner on OpenBeta" })).toHaveAttribute(
    "href",
    "https://openbeta.io/",
  );
  fireEvent.click(screen.getByRole("button", { name: "Attach entry 3, Corner to this activity" }));
  expect(onAttach).toHaveBeenCalledWith(entry.id);
});

it("keeps the owning area's map available when its source omitted the name", () => {
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
  expect(screen.getByRole("region", { name: "Climbing locations" })).toBeInTheDocument();
});

it.each(["Onsight", "Flash"] as const)(
  "shows Kaya color and %s without a count or completed label",
  (label) => {
    const entry = climbingLogEntryFixture({
      providerId: "kaya",
      title: null,
      climb: { ...climbingClimbFixture("kaya"), name: null, kind: "boulder" },
      raw: { climb: { color: { name: "Blue" } } },
      displayGrade: "V5",
      recordedClimbOutcome: "completed",
      recordedClimbAttemptCount: 1,
    });
    entry.attempts = [climbingAttemptFixture(entry.id, { rockResultLabels: ["sent", label] })];
    render(
      <ul>
        <ClimbingLogEntryCard entry={entry} />
      </ul>,
    );
    expect(screen.getByText("Blue boulder")).toBeInTheDocument();
    expect(screen.getByText("V5")).toBeInTheDocument();
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText(/Attempts:|completed/i)).not.toBeInTheDocument();
  },
);
