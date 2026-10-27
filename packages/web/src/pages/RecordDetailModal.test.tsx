// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../../../server/src/repositories/climbing-test-helpers.ts";
import { RecordDetailModal } from "./RecordDetailModal.tsx";

const baseRecord: Record<string, unknown> = {
  id: "abc-123",
  name: "Morning Run",
  started_at: "2024-03-15T10:30:00Z",
  avg_hr: 145,
  max_hr: null,
  cadence: undefined,
  user_id: "user-1",
  raw: { source: "garmin", extra: "data" },
};

afterEach(cleanup);

describe("RecordDetailModal", () => {
  it("keeps cached climbing details visible beside a refresh error", () => {
    const climb = climbingClimbFixture();
    climb.coordinates = { latitude: 0, longitude: -120 };
    render(
      <RecordDetailModal
        dataType="climbingLogEntries"
        state={{
          data: climbingLogEntryFixture({ climb, climbId: climb.id }),
          error: new Error("Detail refresh failed"),
          isLoading: false,
        }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Detail refresh failed");
    expect(screen.getByRole("dialog")).toHaveTextContent("Corner");
    expect(screen.getByRole("dialog")).toHaveTextContent("Grades");
  });
  it("keeps closing available while a detail is loading or unavailable", () => {
    const onClose = vi.fn();
    const view = render(
      <RecordDetailModal
        dataType="climbingLogEntries"
        state={{ data: undefined, error: null, isLoading: true }}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("query-state-loading")).toBeTruthy();
    view.rerender(
      <RecordDetailModal
        dataType="climbingLogEntries"
        state={{ data: null, error: null, isLoading: false }}
        onClose={onClose}
      />,
    );
    expect(
      screen.getByText("This record is no longer available. Refresh the records list."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("renders populated fields and separates empty fields", () => {
    render(
      <RecordDetailModal
        state={{ data: baseRecord, error: null, isLoading: false }}
        dataType="activities"
        onClose={() => {}}
      />,
    );
    const text = screen.getByRole("dialog", { name: "Record Detail" }).textContent ?? "";
    expect(text).toContain("Morning Run");
    expect(text).toContain("Avg Hr");
    expect(text).toContain("Empty Fields (2)");
    expect(text).not.toContain("User Id");
  });

  it("renders raw provider data only for object values", () => {
    const { rerender } = render(
      <RecordDetailModal
        state={{ data: baseRecord, error: null, isLoading: false }}
        dataType="activities"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog").textContent).toContain("Raw Provider Data");
    expect(screen.getByRole("dialog").textContent).toContain('"garmin"');

    rerender(
      <RecordDetailModal
        state={{ data: { id: "1", raw: "text" }, error: null, isLoading: false }}
        dataType="activities"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("Raw Provider Data");
  });

  it("omits the empty fields section when all fields are populated", () => {
    render(
      <RecordDetailModal
        state={{ data: { id: "1", name: "Test" }, error: null, isLoading: false }}
        dataType="activities"
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("dialog").textContent).not.toContain("Empty Fields");
  });

  it("closes from the close button", () => {
    const onClose = vi.fn();
    render(
      <RecordDetailModal
        state={{ data: baseRecord, error: null, isLoading: false }}
        dataType="activities"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <RecordDetailModal
        state={{ data: baseRecord, error: null, isLoading: false }}
        dataType="activities"
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("restores focus when its caller unmounts it", () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open record
          </button>
          {open && (
            <RecordDetailModal
              state={{ data: baseRecord, error: null, isLoading: false }}
              dataType="activities"
              onClose={() => setOpen(false)}
            />
          )}
        </>
      );
    }

    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open record" });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("button", { name: "Close" }), { key: "Escape" });

    expect(trigger).toHaveFocus();
  });
});
