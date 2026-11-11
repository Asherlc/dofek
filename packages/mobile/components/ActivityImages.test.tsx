import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureException } from "../lib/telemetry";
import { ActivityImages, ActivityPhoto } from "./ActivityImages";
import { activityImageFixture } from "./activity-images-test-helpers";

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));

describe("ActivityImages", () => {
  it("keeps other photos reachable when the summary preview fails", () => {
    render(
      <ActivityImages
        heading={<span>Morning ride</span>}
        images={[
          activityImageFixture,
          {
            ...activityImageFixture,
            id: "photo-2",
            url: "https://images.example.test/finish.jpg",
            sources: activityImageFixture.sources.map((source) => ({
              ...source,
              caption: "Finish",
            })),
          },
        ]}
        onRetry={vi.fn()}
      />,
    );
    fireEvent.error(screen.getByLabelText("View from the summit"));
    fireEvent.click(screen.getByRole("button", { name: "View 2 photos" }));
    const viewer = screen.getByLabelText("Activity photo");
    fireEvent.click(within(viewer).getByRole("button", { name: "Open photo 2: Finish" }));
    expect(within(viewer).getByText("Finish")).toBeTruthy();
  });
  it("refreshes a failed viewer photo when its signed URL is unchanged", () => {
    const retry = vi.fn();
    render(
      <ActivityImages
        images={[activityImageFixture]}
        heading={<span>Morning ride</span>}
        onRetry={retry}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "View 1 photo" }));
    const viewer = screen.getByLabelText("Activity photo");
    fireEvent.error(within(viewer).getByLabelText("View from the summit"));
    fireEvent.click(within(viewer).getByRole("button", { name: "Refresh photos" }));
    expect(within(viewer).getByLabelText("View from the summit")).toBeTruthy();
    expect(retry).toHaveBeenCalledOnce();
  });
  it("opens all photos from a single summary preview", () => {
    render(
      <ActivityImages
        images={[
          activityImageFixture,
          {
            ...activityImageFixture,
            id: "photo-2",
            sources: activityImageFixture.sources.map((source) => ({
              ...source,
              caption: "Finish",
            })),
          },
        ]}
        heading={<span>Morning ride</span>}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Morning ride")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View 2 photos" }));
    const viewer = screen.getByLabelText("Activity photo");
    fireEvent.click(within(viewer).getByRole("button", { name: "Open photo 2: Finish" }));
    expect(within(viewer).getByText("Finish")).toBeTruthy();
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens a downloaded image full screen and closes the photo viewer", () => {
    render(<ActivityImages images={[activityImageFixture]} onRetry={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Open photo 1: View from the summit" }));

    const viewer = screen.getByLabelText("Activity photo");
    expect(within(viewer).getByText("View from the summit")).toBeTruthy();
    expect(within(viewer).getByText("Strava")).toBeTruthy();
    expect(within(viewer).getByLabelText("View from the summit")).toBeTruthy();
    fireEvent.click(within(viewer).getByRole("button", { name: "Close photo" }));
    expect(screen.queryByLabelText("Activity photo")).toBeNull();
  });

  it("shows loading while the gallery is first requested and omits a completed empty gallery", () => {
    const view = render(<ActivityImages images={[]} loading onRetry={vi.fn()} />);
    expect(screen.getByRole("progressbar")).toBeTruthy();
    view.rerender(<ActivityImages images={[]} onRetry={vi.fn()} />);
    expect(view.container.textContent).toBe("");
  });

  it("closes a selected photo when it is removed and does not reopen it if it returns", () => {
    const view = render(<ActivityImages images={[activityImageFixture]} onRetry={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open photo 1: View from the summit" }));
    expect(screen.getByLabelText("Activity photo")).toBeTruthy();
    view.rerender(<ActivityImages images={[]} onRetry={vi.fn()} />);
    expect(screen.queryByLabelText("Activity photo")).toBeNull();
    view.rerender(<ActivityImages images={[activityImageFixture]} onRetry={vi.fn()} />);
    expect(screen.queryByLabelText("Activity photo")).toBeNull();
  });

  it("keeps downloaded photos visible during refresh and exposes the server error and retry", () => {
    const retry = vi.fn();
    const view = render(<ActivityImages images={[activityImageFixture]} loading onRetry={retry} />);
    expect(screen.getByRole("button", { name: "Open photo 1: View from the summit" })).toBeTruthy();
    view.rerender(
      <ActivityImages
        images={[activityImageFixture]}
        error={new Error("The photo service is unavailable. Retry shortly.")}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("button", { name: "Open photo 1: View from the summit" })).toBeTruthy();
    expect(screen.getByText("The photo service is unavailable. Retry shortly.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry photos" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows an error before any images have loaded", () => {
    render(
      <ActivityImages images={[]} error={new Error("Photo access denied")} onRetry={vi.fn()} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Photo access denied");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("ActivityPhoto", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the signed download URL and keeps a loading state until the image loads", () => {
    const createElement = vi.spyOn(React, "createElement");
    render(<ActivityPhoto image={activityImageFixture} onRetry={vi.fn()} />);
    expect(createElement).toHaveBeenCalledWith(
      "image",
      expect.objectContaining({ source: { uri: activityImageFixture.url } }),
      undefined,
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    fireEvent.load(screen.getByLabelText("View from the summit"));
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("offers retry for failed images, reports a safe error, and resets for a renewed URL", () => {
    const retry = vi.fn();
    const view = render(<ActivityPhoto image={activityImageFixture} onRetry={retry} />);
    fireEvent.error(screen.getByLabelText("View from the summit"));
    expect(screen.getByText("Photo unavailable")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry photo" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByText("Photo unavailable")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
    expect(captureException).toHaveBeenCalledWith(new Error("Activity photo failed to load"), {
      source: "activity-photo",
    });
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain("signature");

    view.rerender(
      <ActivityPhoto
        image={{ ...activityImageFixture, url: "https://images.example.test/renewed.jpg" }}
        onRetry={retry}
      />,
    );
    expect(screen.queryByText("Photo unavailable")).toBeNull();
    expect(screen.getByRole("progressbar")).toBeTruthy();
  });
});
