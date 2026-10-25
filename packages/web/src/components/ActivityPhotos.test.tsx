/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPhotos } from "./ActivityPhotos.tsx";

const image = {
  id: "photo-1",
  url: "https://private.test/photo",
  width: 1200,
  height: 800,
  mimeType: "image/jpeg",
  sizeBytes: 12000,
  sources: [
    {
      activityId: "activity-1",
      providerId: "strava",
      sourceId: "source-1",
      kind: "photo",
      caption: "Summit",
      position: 0,
    },
  ],
};

afterEach(cleanup);

describe("ActivityPhotos", () => {
  it("opens the selected photo, closes with Escape, and returns focus to the thumbnail", async () => {
    render(<ActivityPhotos images={[image]} loading={false} error={null} onRetry={vi.fn()} />);
    const thumbnail = screen.getByRole("button", { name: "Enlarge Summit" });
    thumbnail.focus();
    fireEvent.click(thumbnail);
    const dialog = screen.getByRole("dialog", { name: "Summit" });
    expect(within(dialog).getByRole("img", { name: "Summit" })).toHaveAttribute("src", image.url);
    expect(within(dialog).getByText("Strava")).toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(thumbnail).toHaveFocus();
  });

  it("keeps cached photos visible during a background refresh error and lets users retry", () => {
    const retry = vi.fn();
    render(
      <ActivityPhotos
        images={[image]}
        loading={true}
        error={new Error("Photo storage is unavailable. Try again.")}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("button", { name: "Enlarge Summit" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Photo storage is unavailable. Try again.");
    fireEvent.click(screen.getByRole("button", { name: "Refresh photos" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("announces initial loading separately from a successful empty result", () => {
    const { rerender, container } = render(
      <ActivityPhotos images={[]} loading={true} error={null} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("status")).toHaveAccessibleName("Loading photos.");
    rerender(<ActivityPhotos images={[]} loading={false} error={null} onRetry={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("retries a failed thumbnail even if refreshed signing returns the same URL", () => {
    const retry = vi.fn();
    render(<ActivityPhotos images={[image]} loading={false} error={null} onRetry={retry} />);
    fireEvent.error(screen.getByRole("img", { name: "Summit" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh photos");
    fireEvent.click(screen.getByRole("button", { name: "Refresh photos" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "Summit" })).toHaveAttribute("src", image.url);
  });

  it("closes a selected photo when the image is no longer in the activity", () => {
    const { rerender } = render(
      <ActivityPhotos images={[image]} loading={false} error={null} onRetry={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Enlarge Summit" }));
    rerender(<ActivityPhotos images={[]} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    rerender(<ActivityPhotos images={[image]} loading={false} error={null} onRetry={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
