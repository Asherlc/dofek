/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecentActivitiesSection } from "./RecentActivitiesSection.tsx";

const mutate = vi.fn();
const mutateAsync = vi.fn();

vi.mock("../lib/trainingDaysContext.ts", () => ({
  useTrainingDays: () => ({ days: 30 }),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      activity: {
        list: { invalidate: vi.fn() },
      },
    }),
    activity: {
      list: {
        useQuery: () => ({
          data: { items: [], totalCount: 0 },
          isLoading: false,
          error: null,
        }),
      },
      bulkDelete: {
        useMutation: () => ({
          mutate,
          mutateAsync,
          isPending: false,
          error: null,
        }),
      },
    },
  },
}));

vi.mock("./ActivityList.tsx", () => ({
  ActivityList: ({ onBulkDelete }: { onBulkDelete: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onBulkDelete(["00000000-0000-0000-0000-000000000001"])}>
      Delete selected
    </button>
  ),
}));

describe("RecentActivitiesSection", () => {
  it("uses mutation state instead of awaiting bulk delete", () => {
    render(<RecentActivitiesSection />);

    fireEvent.click(screen.getByText("Delete selected"));

    expect(mutate).toHaveBeenCalledWith({ ids: ["00000000-0000-0000-0000-000000000001"] });
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
