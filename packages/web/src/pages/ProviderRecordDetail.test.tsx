// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { climbingLogEntryFixture } from "../../../server/src/repositories/climbing-test-helpers.ts";
import { ProviderRecordDetail } from "./ProviderRecordDetail.tsx";

const { useQuery } = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock("../lib/trpc.ts", () => ({ trpc: { providerDetail: { recordDetail: { useQuery } } } }));

it("requests current traits while rendering a valid old-server climbing response", () => {
  const { holdTypes: _holdTypes, ...entry } = climbingLogEntryFixture();
  useQuery.mockReturnValue({ data: { ...entry, holdType: "jug" }, isLoading: false, error: null });
  const input = {
    providerId: entry.providerId,
    dataType: "climbingLogEntries" as const,
    recordId: entry.id,
  };
  render(<ProviderRecordDetail input={input} onClose={() => {}} />);
  expect(useQuery).toHaveBeenCalledWith({ ...input, responseVersion: 3 });
  expect(screen.getByText("Hold types: jug")).toBeInTheDocument();
});

it("preserves unrelated provider records", () => {
  useQuery.mockReturnValue({
    data: { id: "food", food_name: "Lunch" },
    isLoading: false,
    error: null,
  });
  render(
    <ProviderRecordDetail
      input={{ providerId: "food-source", dataType: "foodEntries", recordId: "food" }}
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Lunch")).toBeInTheDocument();
});
