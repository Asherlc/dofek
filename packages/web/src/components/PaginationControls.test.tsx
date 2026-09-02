/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaginationControls } from "./PaginationControls.tsx";

describe("PaginationControls", () => {
  it("moves between pages and reports the current position", () => {
    const onPageChange = vi.fn();

    render(
      <PaginationControls
        page={1}
        pageSize={20}
        totalItems={45}
        itemLabel="activities"
        onPageChange={onPageChange}
      />,
    );

    expect(screen.getByText("45 activities")).toBeDefined();
    expect(screen.getByText("2 / 3")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Previous activities page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next activities page" }));

    expect(onPageChange).toHaveBeenNthCalledWith(1, 0);
    expect(onPageChange).toHaveBeenNthCalledWith(2, 2);
  });

  it("does not render for a single page", () => {
    const { container } = render(
      <PaginationControls
        page={0}
        pageSize={20}
        totalItems={20}
        itemLabel="activities"
        onPageChange={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
