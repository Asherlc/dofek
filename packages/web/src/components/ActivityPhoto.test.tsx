/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityPhoto } from "./ActivityPhoto.tsx";

vi.mock("../lib/telemetry.ts", () => ({ captureException: vi.fn() }));

import { captureException } from "../lib/telemetry.ts";

const image = {
  id: "photo-1",
  url: "https://private.test/photo?signed=secret",
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityPhoto", () => {
  it("renders the downloaded image with its caption and stored dimensions", () => {
    render(<ActivityPhoto image={image} />);
    const photo = screen.getByRole("img", { name: "Summit" });
    expect(photo).toHaveAttribute("src", image.url);
    expect(photo).toHaveAttribute("width", "1200");
    expect(photo).toHaveAttribute("height", "800");
    expect(photo).toHaveAttribute("referrerpolicy", "no-referrer");
    fireEvent.load(photo);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports a load failure without leaking the signed URL and retries a renewed URL", () => {
    const { rerender } = render(<ActivityPhoto image={image} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.getByRole("alert")).toHaveTextContent("Refresh photos to try again");
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain("secret");
    rerender(<ActivityPhoto image={{ ...image, url: "https://private.test/renewed" }} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("img")).toHaveAttribute("src", "https://private.test/renewed");
  });
});
