// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileImportZone } from "./FileImportZone.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="/providers/strong-csv">{children}</a>,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FileImportZone", () => {
  it("resumes an active import after the page is refreshed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise<Response>(() => {
          // Keep the resumed status request pending so the restored progress remains visible.
        }),
    );
    vi.stubGlobal("fetch", fetchImpl);
    const refreshedProps = {
      providerId: "garmin-dump",
      title: "Garmin",
      description: ".zip from Garmin Connect",
      accept: ".zip",
      uploadUrl: "/api/upload/garmin-dump",
      statusUrl: "/api/upload/garmin-dump/status",
      activeImport: {
        jobId: "job-garmin",
        progress: 64,
        message: "Importing activities",
      },
    };

    render(<FileImportZone {...refreshedProps} />);

    expect(screen.getByText("Importing activities")).toBeTruthy();
    await waitFor(() =>
      expect(fetchImpl).toHaveBeenCalledWith("/api/upload/garmin-dump/status/job-garmin"),
    );
  });

  it("renders an explicit file picker button", () => {
    render(
      <FileImportZone
        providerId="strong-csv"
        title="Strong"
        description=".csv export from Strong app"
        accept=".csv"
        uploadUrl="/api/upload/strong-csv?units=kg"
        statusUrl="/api/upload/strong-csv/status"
      />,
    );

    expect(screen.getByRole("button", { name: "Import file" })).toBeTruthy();
    expect(screen.getByText(".csv export from Strong app")).toBeTruthy();
  });

  it("renders provider summary totals on file import tiles", () => {
    render(
      <FileImportZone
        providerId="strong-csv"
        title="Strong"
        description=".csv export from Strong app"
        accept=".csv"
        uploadUrl="/api/upload/strong-csv?units=kg"
        statusUrl="/api/upload/strong-csv/status"
        stats={{
          activities: 352,
          metricStream: 205_367,
          dailyMetrics: 229,
          sleepSessions: 155,
          bodyMeasurements: 43,
          healthEvents: 392,
          foodEntries: 0,
          nutritionDaily: 0,
          labPanels: 0,
          labResults: 0,
          journalEntries: 0,
        }}
      />,
    );

    expect(screen.getByText("206,538")).toBeTruthy();
    expect(screen.getByText("records")).toBeTruthy();
    expect(screen.getByText("Activities")).toBeTruthy();
    expect(screen.getByText("352")).toBeTruthy();
    expect(screen.getByText("Metric Stream")).toBeTruthy();
    expect(screen.getByText("205,367")).toBeTruthy();
    expect(screen.getByText("Daily Metrics")).toBeTruthy();
    expect(screen.getByText("229")).toBeTruthy();
    expect(screen.getByText("Sleep")).toBeTruthy();
    expect(screen.getByText("155")).toBeTruthy();
    expect(screen.getByText("Body")).toBeTruthy();
    expect(screen.getByText("43")).toBeTruthy();
    expect(screen.getByText("Events")).toBeTruthy();
    expect(screen.getByText("392")).toBeTruthy();
  });

  it("preserves the selected FIT extension for chunked uploads", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-fit" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "done", progress: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchImpl);

    render(
      <FileImportZone
        providerId="fit-file"
        title="FIT File"
        description=".fit activity or weight file"
        accept=".fit"
        uploadUrl="/api/upload/fit-file"
        statusUrl="/api/upload/fit-file/status"
        chunked
      />,
    );

    fireEvent.drop(screen.getByRole("region", { name: "FIT File file drop zone" }), {
      dataTransfer: { files: [new File(["fit-data"], "morning-ride.fit")] },
    });

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      "/api/upload/fit-file",
      expect.objectContaining({
        headers: expect.objectContaining({ "x-file-ext": ".fit" }),
      }),
    );
  });

  it("shows failedCount when progress reports file failures", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobId: "job-gh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "processing",
            progress: 46,
            message: "356 of 15774 complete, 15418 failed",
            failedCount: 15418,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchImpl);

    render(
      <FileImportZone
        providerId="garmin-dump"
        title="Garmin"
        description=".zip from Garmin Connect"
        accept=".zip"
        uploadUrl="/api/upload/garmin-dump"
        statusUrl="/api/upload/garmin-dump/status"
        chunked
      />,
    );

    fireEvent.drop(screen.getByRole("region", { name: "Garmin file drop zone" }), {
      dataTransfer: { files: [new File(["zip-data"], "garmin-export.zip")] },
    });

    await waitFor(() => expect(screen.getByText("15,418 files failed")).toBeTruthy());
  });
});
