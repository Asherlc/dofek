// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatCellValue, formatColumnName, RecordDetailModal } from "./ProviderDetailPage";

afterEach(cleanup);

function queryButton(container: HTMLElement, ariaLabel: string): Element {
  const el = container.querySelector(`button[aria-label="${ariaLabel}"]`);
  if (el === null) throw new Error(`Expected a <button> with aria-label="${ariaLabel}"`);
  return el;
}

describe("formatColumnName", () => {
  it("converts snake_case to Title Case", () => {
    expect(formatColumnName("started_at")).toBe("Started At");
  });

  it("handles single words", () => {
    expect(formatColumnName("name")).toBe("Name");
  });

  it("handles multiple underscores", () => {
    expect(formatColumnName("avg_heart_rate")).toBe("Avg Heart Rate");
  });
});

describe("formatCellValue", () => {
  it("returns em dash for null", () => {
    expect(formatCellValue(null)).toBe("—");
  });

  it("returns em dash for undefined", () => {
    expect(formatCellValue(undefined)).toBe("—");
  });

  it("returns 'Yes' for true", () => {
    expect(formatCellValue(true)).toBe("Yes");
  });

  it("returns 'No' for false", () => {
    expect(formatCellValue(false)).toBe("No");
  });

  it("returns JSON for objects", () => {
    expect(formatCellValue({ foo: 1 })).toBe('{"foo":1}');
  });

  it("formats ISO date strings", () => {
    const result = formatCellValue("2024-03-15T10:30:00Z");
    // formatTime returns locale-formatted string; just verify it doesn't return the raw ISO
    expect(result).not.toBe("2024-03-15T10:30:00Z");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns plain strings as-is", () => {
    expect(formatCellValue("hello")).toBe("hello");
  });

  it("converts numbers to strings", () => {
    expect(formatCellValue(42)).toBe("42");
  });
});

describe("RecordDetailModal", () => {
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

  it("renders populated fields", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Morning Run");
    expect(text).toContain("Id");
    expect(text).toContain("Avg Hr");
  });

  it("excludes raw and user_id from fields", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("User Id");
  });

  it("shows null fields in collapsed section with count", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    // max_hr and cadence are null/undefined
    expect(text).toContain("Empty Fields (2)");
  });

  it("does not show empty fields section when no null fields", () => {
    const record = { id: "1", name: "Test" };
    const { container } = render(<RecordDetailModal record={record} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Empty Fields");
  });

  it("renders raw provider data when present", () => {
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).toContain("Raw Provider Data");
    expect(text).toContain('"source"');
    expect(text).toContain('"garmin"');
  });

  it("does not render raw section when raw is absent", () => {
    const record = { id: "1", name: "Test" };
    const { container } = render(<RecordDetailModal record={record} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Raw Provider Data");
  });

  it("calls onClose when backdrop is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={onClose} />);
    const backdrop = queryButton(container, "Close dialog");
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when X button is clicked", () => {
    const onClose = vi.fn();
    const { container } = render(<RecordDetailModal record={baseRecord} onClose={onClose} />);
    const closeButton = queryButton(container, "Close");
    fireEvent.click(closeButton);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not treat raw as an object when raw is a primitive", () => {
    const record = { id: "1", raw: "not-an-object" };
    const { container } = render(<RecordDetailModal record={record} onClose={() => {}} />);
    const text = container.textContent ?? "";
    expect(text).not.toContain("Raw Provider Data");
  });
});
