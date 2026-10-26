// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { View } from "react-native";
import { describe, expect, it, vi } from "vitest";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../server/src/repositories/climbing-test-helpers.ts";
import { ClimbingLogEntryBreakdown } from "./ClimbingLogEntryBreakdown";
import { climbingLogFixture, exactClimbingLocation } from "./climbing-log-entry-fixtures";

it("keeps a completed pitch scoped", () => {
  const entry = climbingLogEntryFixture({
    title: "A recorded outing",
    recordedPitchAttemptCount: 1,
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id, {
      scope: "pitch",
      outcome: "completed",
      usedAid: true,
      solo: true,
    }),
  ];
  entry.pitchResults = [
    {
      pitch: null,
      attemptIds: [entry.attempts[0]?.id ?? ""],
      recordedAttemptCount: 1,
      recordedOutcome: "completed",
      displayGrade: null,
    },
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("A recorded outing")).toBeTruthy();
  expect(screen.getByText("Unidentified pitch · Attempts: 1")).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
});
it("renders the server's unknown occurrence count with its current published display grade", () => {
  const entry = climbingLogEntryFixture({
    climb: climbingClimbFixture(),
    displayGrade: "5.10a",
    recordedClimbAttemptCount: 1,
  });
  entry.attempts = [climbingAttemptFixture(entry.id, { ropeMethod: "top_rope" })];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("Corner")).toBeTruthy();
  expect(screen.getByText("5.10a")).toBeTruthy();
  expect(screen.getByText("Attempts: 1")).toBeTruthy();
});

it("shows pitch completion with unknown whole-climb outcome", () => {
  const entry = climbingLogEntryFixture({
    recordedClimbAttemptCount: 1,
    recordedPitchAttemptCount: 1,
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id),
    climbingAttemptFixture(entry.id, {
      id: "20000000-0000-4000-8000-000000000021",
      scope: "pitch",
      outcome: "completed",
    }),
  ];
  entry.pitchResults = [
    {
      pitch: null,
      attemptIds: [entry.attempts[1]?.id ?? ""],
      recordedAttemptCount: 1,
      recordedOutcome: "completed",
      displayGrade: null,
    },
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("Unidentified pitch · Attempts: 1")).toBeTruthy();
  expect(screen.getByText("Completed")).toBeTruthy();
  expect(screen.getByText("Attempts: 1")).toBeTruthy();
});
it("shows a completed dab without a send label", () => {
  const entry = climbingLogEntryFixture({
    recordedClimbAttemptCount: 1,
    recordedClimbOutcome: "completed",
  });
  entry.attempts = [
    climbingAttemptFixture(entry.id, {
      outcome: "completed",
      usedAid: false,
      fellOrHung: false,
      dabbed: true,
    }),
  ];
  render(<ClimbingLogEntryBreakdown entries={[entry]} />);
  expect(screen.getByText("Completed")).toBeTruthy();
  expect(screen.getByText("Attempts: 1")).toBeTruthy();
  expect(screen.queryByText("Sent")).toBeNull();
});

describe("ClimbingLogEntryBreakdown", () => {
  it("shows overlapping source areas under one heading and preserves each attachment", () => {
    const climb = climbingLogFixture.climb;
    if (!climb) throw new Error("Expected a climb fixture");
    const onAttach = vi.fn();
    render(
      <ClimbingLogEntryBreakdown
        entries={[
          climbingLogFixture,
          {
            ...climbingLogFixture,
            id: "openbeta-log",
            providerId: "openbeta",
            sourceName: "OpenBeta",
            sourceLinks: [
              {
                kind: "route",
                providerId: "openbeta",
                url: "https://openbeta.io/climb/10000000-0000-4000-8000-000000000001",
              },
            ],
            climb: {
              ...climb,
              providerId: "openbeta",
              name: "Road Kill",
              areaPath: climb.areaPath.map((area) => ({
                ...area,
                providerId: "openbeta",
                id: `openbeta-${area.id}`,
              })),
            },
          },
        ]}
        onAttach={onAttach}
      />,
    );
    expect(screen.getAllByText("Goat Rock")).toHaveLength(1);
    const group = within(screen.getByLabelText("Goat Rock"));
    expect(group.getByRole("link", { name: "Swiss Cheese on Mountain Project" })).toBeTruthy();
    expect(group.getByRole("link", { name: "Road Kill on OpenBeta" })).toBeTruthy();
    fireEvent.click(
      group.getByRole("button", { name: "Attach entry 2, Road Kill to this activity" }),
    );
    expect(onAttach).toHaveBeenCalledWith("openbeta-log");
  });
  it("groups nonadjacent climbs under their area heading and keeps attachment identities", () => {
    const climb = climbingLogFixture.climb;
    const area = climb?.areaPath.at(-1);
    if (!climb || !area) throw new Error("Expected an area fixture");
    render(
      <ClimbingLogEntryBreakdown
        entries={[
          climbingLogFixture,
          {
            ...climbingLogFixture,
            id: "other-area",
            climb: {
              ...climb,
              name: "Other climb",
              areaPath: [{ ...area, id: "other-area", name: "North Wall" }],
            },
          },
          { ...climbingLogFixture, id: "repeat" },
        ]}
        onAttach={vi.fn()}
      />,
    );
    const goatRock = screen.getByLabelText("Goat Rock");
    expect(within(goatRock).getByText("Goat Rock")).toBeTruthy();
    expect(within(goatRock).getAllByLabelText("Climbing entry: Swiss Cheese")).toHaveLength(2);
    expect(
      within(goatRock).getByRole("button", {
        name: "Attach entry 3, Swiss Cheese to this activity",
      }),
    ).toBeTruthy();
    expect(within(screen.getByLabelText("North Wall")).getByText("Other climb")).toBeTruthy();
  });
  it("identifies the selected repeated card by full entry order including a locationless entry", () => {
    render(
      <ClimbingLogEntryBreakdown
        entries={[
          climbingLogFixture,
          { ...climbingLogFixture, id: "indoor", climb: null, title: "Indoor" },
          { ...climbingLogFixture, id: "repeat" },
        ]}
        locations={{ "tick-1": exactClimbingLocation, repeat: exactClimbingLocation }}
        selectedEntryId="repeat"
      />,
    );
    const cards = screen.getAllByLabelText(/Climbing entry:/);
    expect(cards.map((card) => card.getAttribute("aria-label"))).toEqual([
      "Climbing entry: Swiss Cheese",
      "Climbing entry: Swiss Cheese",
      "Climbing entry: Indoor",
    ]);
    expect(cards[1]?.querySelector('[data-accessible="true"][aria-selected="true"]')).toBeTruthy();
  });
  it("preserves source order and repeated ticks at one point", () => {
    render(
      <ClimbingLogEntryBreakdown
        entries={[
          { ...climbingLogFixture, id: "second", climb: null, title: "First occurrence" },
          climbingLogFixture,
        ]}
        locations={{ second: exactClimbingLocation, "tick-1": exactClimbingLocation }}
      />,
    );
    const cards = screen.getAllByLabelText(/Climbing entry:/);
    expect(cards).toHaveLength(2);
    expect(cards[0]?.getAttribute("aria-label")).toBe("Climbing entry: First occurrence");
    expect(cards[1]?.getAttribute("aria-label")).toBe("Climbing entry: Swiss Cheese");
  });

  it("allows a 280px cell basis to shrink inside the 256px padded screen content", () => {
    render(
      <View style={{ width: 320, padding: 16 }}>
        <View style={{ padding: 16 }}>
          <ClimbingLogEntryBreakdown
            entries={[
              {
                ...climbingLogFixture,
                climb: null,
                title: "Long route name across the entire California coastal climbing area",
              },
            ]}
            onAttach={vi.fn()}
          />
        </View>
      </View>,
    );
    const card = screen.getByLabelText(
      "Climbing entry: Long route name across the entire California coastal climbing area",
    );
    expect(card.parentElement?.style.flexShrink).toBe("1");
    expect(
      within(card)
        .getByRole("button", {
          name: "Attach entry 1, Long route name across the entire California coastal climbing area to this activity",
        })
        .getAttribute("disabled"),
    ).toBeNull();
  });

  it("retains long names and source links while each Attach state remains independent", () => {
    const name =
      "A very long route name across the upper wall above the California coastal climbing area";
    const onAttach = vi.fn();
    render(
      <ClimbingLogEntryBreakdown
        entries={[
          { ...climbingLogFixture, climb: null, title: name },
          { ...climbingLogFixture, climb: null, id: "tick-2", title: "Second route" },
        ]}
        attachmentStates={{
          "tick-1": { pending: true, error: null },
          "tick-2": { pending: false, error: "Choose a climbing activity." },
        }}
        onAttach={onAttach}
      />,
    );
    expect(screen.getByRole("link", { name: `${name} on Mountain Project` })).toBeTruthy();
    const cards = screen.getAllByLabelText(/Climbing entry:/);
    const first = cards[0];
    const second = cards[1];
    if (!first || !second) throw new Error("Expected two tick cards");
    const firstControl = within(first).getByRole("button", {
      name: `Attach entry 1, ${name} to this activity`,
    });
    expect(firstControl.getAttribute("disabled")).not.toBeNull();
    expect(within(first).getByText("Attaching...")).toBeTruthy();
    expect(within(first).queryByText("Choose a climbing activity.")).toBeNull();
    expect(within(second).getByText("Choose a climbing activity.")).toBeTruthy();
    fireEvent.click(
      within(second).getByRole("button", { name: "Attach entry 2, Second route to this activity" }),
    );
    expect(onAttach).toHaveBeenCalledWith("tick-2");
  });
});
