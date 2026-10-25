import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPhotoPreview } from "./ActivityPhotoPreview";
import { activityImageFixture } from "./activity-images-test-helpers";

const query = vi.hoisted(() => vi.fn());
vi.mock("../lib/trpc", () => ({ trpc: { activity: { images: { useQuery: query } } } }));

describe("ActivityPhotoPreview", () => {
  beforeEach(() => query.mockReset());

  it("shows the first downloaded photo from the activity query", () => {
    query.mockReturnValue({
      data: {
        images: [activityImageFixture, { ...activityImageFixture, id: "second" }],
        coverage: [],
        acquisition: [],
      },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<ActivityPhotoPreview activityId="activity-1" />);
    expect(screen.getAllByLabelText("View from the summit")).toHaveLength(1);
    expect(query).toHaveBeenCalledWith(
      { id: "activity-1" },
      expect.objectContaining({ staleTime: 0, refetchOnMount: "always", meta: { persist: false } }),
    );
  });

  it("keeps a downloaded photo visible after refresh errors and directs retries to the activity", () => {
    const refetch = vi.fn();
    query.mockReturnValue({
      data: { images: [activityImageFixture], coverage: [], acquisition: [] },
      error: new Error("Photos could not be refreshed. Try again."),
      isLoading: false,
      isFetching: false,
      refetch,
    });
    render(<ActivityPhotoPreview activityId="activity-1" />);
    expect(screen.getByLabelText("View from the summit")).toBeTruthy();
    expect(screen.getByText("Photos could not be refreshed. Try again.")).toBeTruthy();
    expect(screen.getByText("Open activity to refresh photos.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("keeps loading and empty states distinct", () => {
    query.mockReturnValue({
      data: undefined,
      error: null,
      isLoading: true,
      isFetching: true,
      refetch: vi.fn(),
    });
    const view = render(<ActivityPhotoPreview activityId="activity-1" />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    query.mockReturnValue({
      data: { images: [], coverage: [], acquisition: [] },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    view.rerender(<ActivityPhotoPreview activityId="activity-1" />);
    expect(view.container.textContent).toBe("");
  });

  it("keeps photo failures actionable through the card without nesting another control", () => {
    query.mockReturnValue({
      data: { images: [activityImageFixture], coverage: [], acquisition: [] },
      error: null,
      isLoading: false,
      isFetching: false,
      refetch: vi.fn(),
    });
    render(<ActivityPhotoPreview activityId="activity-1" />);
    fireEvent.error(screen.getByLabelText("View from the summit"));
    expect(screen.getByText("Photo unavailable")).toBeTruthy();
    expect(screen.getByText("Open activity to refresh photos.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
