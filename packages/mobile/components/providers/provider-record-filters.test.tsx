// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ProviderRecordFilters } from "./provider-record-filters";

it("uses independent date bounds and supplied source options", () => {
  const onChange = vi.fn();
  render(
    <ProviderRecordFilters
      columns={["climbed_on", "discipline"]}
      filters={{ climbed_on_from: "2026-10-01" }}
      options={{ discipline: [{ value: "mountaineering", label: "Mountaineering" }] }}
      onChange={onChange}
    />,
  );
  fireEvent.change(screen.getByLabelText("Filter Climbed On to"), {
    target: { value: "2026-10-12" },
  });
  expect(onChange).toHaveBeenCalledWith("climbed_on_to", "2026-10-12");
  fireEvent.click(screen.getByRole("button", { name: "Discipline: Mountaineering" }));
  expect(onChange).toHaveBeenCalledWith("discipline", "mountaineering");
  fireEvent.click(screen.getByRole("button", { name: "All Discipline" }));
  expect(onChange).toHaveBeenCalledWith("discipline", "");
});
