// @vitest-environment jsdom
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

function queryButton(container: HTMLElement, ariaLabel: string): Element {
  const element = container.querySelector(`button[aria-label="${ariaLabel}"]`);
  if (!element) throw new Error(`Expected a button with aria-label="${ariaLabel}"`);
  return element;
}

describe("RecordDetailModal", () => {
  it("renders populated fields and separates empty fields", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Morning Run");
    expect(text).toContain("Avg Hr");
    expect(text).toContain("Empty Fields (2)");
    expect(text).not.toContain("User Id");
  });

  it("renders raw provider data only for object values", () => {
    const { container, rerender } = render(
      <RecordDetailModal record={baseRecord} onClose={() => {}} />,
    );
    expect(container.textContent).toContain("Raw Provider Data");
    expect(container.textContent).toContain('"garmin"');

    rerender(<RecordDetailModal record={{ id: "1", raw: "text" }} onClose={() => {}} />);
    expect(container.textContent).not.toContain("Raw Provider Data");
  });

  it("omits the empty fields section when all fields are populated", () => {
    const { container } = render(
      <RecordDetailModal record={{ id: "1", name: "Test" }} onClose={() => {}} />,
    );
    expect(container.textContent).not.toContain("Empty Fields");
  });

  it.each(["Close dialog", "Close"])("closes from %s", (ariaLabel) => {
    const onClose = vi.fn();
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={onClose} />);
    fireEvent.click(queryButton(container, ariaLabel));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
