import { QueryClient } from "@tanstack/react-query";
import { createTRPCClient } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { describe, expect, it } from "vitest";
import {
  createProcessingStatusStoryLink,
  seedReadyProcessingStatus,
} from "../../app/(tabs)/_processing-status-story-fixture";

describe("seedReadyProcessingStatus", () => {
  it("seeds the exact processing status query used by screenshot stories", () => {
    const queryClient = new QueryClient();
    const datasets = ["activity", "sleep", "recovery", "training", "body"] as const;

    seedReadyProcessingStatus(queryClient, datasets);

    expect(
      queryClient.getQueryData([["processing", "status"], { input: { datasets }, type: "query" }]),
    ).toEqual({
      generatedAt: expect.any(String),
      scope: { providerId: null, datasets },
      overallStatus: "ready",
      datasets: [
        expect.objectContaining({ key: "activity", label: "Activities", status: "ready" }),
        expect.objectContaining({ key: "sleep", label: "Sleep", status: "ready" }),
        expect.objectContaining({ key: "recovery", label: "Recovery", status: "ready" }),
        expect.objectContaining({ key: "training", label: "Training", status: "ready" }),
        expect.objectContaining({ key: "body", label: "Body", status: "ready" }),
      ],
      operations: [],
    });
  });

  it("serves every processing status poll without reaching the network", async () => {
    const queryClient = new QueryClient();
    const datasets = ["activity", "sleep", "recovery"] as const;
    const snapshot = seedReadyProcessingStatus(queryClient, datasets);
    const client = createTRPCClient<AppRouter>({
      links: [createProcessingStatusStoryLink(snapshot)],
    });

    await expect(client.processing.status.query({ datasets: [...datasets] })).resolves.toEqual(
      snapshot,
    );
    await expect(client.processing.status.query({ datasets: [...datasets] })).resolves.toEqual(
      snapshot,
    );
    await expect(
      client.mobileDashboard.recovery.query({ days: 30, endDate: "2026-07-28" }),
    ).rejects.toThrow("Unhandled processing-status story tRPC operation: mobileDashboard.recovery");
  });

  it("serves declared companion queries and still rejects unknown operations", async () => {
    const queryClient = new QueryClient();
    const datasets = ["activity", "recovery", "training"] as const;
    const snapshot = seedReadyProcessingStatus(queryClient, datasets);
    const hrZones = {
      maxHr: 190,
      weeks: [],
      intensityDistribution: {
        model: "karvonen-five-zone" as const,
        activityScope: "endurance" as const,
        totalSeconds: 0,
        zones: [],
        explanation: "No intensity samples in this fixture.",
      },
    };
    const polarizationTrend = {
      model: "treff-three-zone" as const,
      activityScope: "cycling" as const,
      threshold: 2,
      maxHr: 190,
      weeks: [],
      explanation: "No cycling polarization samples in this fixture.",
      method: {
        formula: "Fixture formula.",
        zoneBasis: "Fixture zones.",
        calculationChoice: "Fixture calculation.",
        interpretation: "Fixture interpretation.",
        source: {
          title: "Treff source",
          url: "https://doi.org/10.3389/fphys.2019.00707",
        },
      },
    };
    const client = createTRPCClient<AppRouter>({
      links: [
        createProcessingStatusStoryLink(snapshot, {
          "training.hrZones": hrZones,
          "efficiency.polarizationTrend": polarizationTrend,
          "cyclingAdvanced.trainingMonotony": [],
        }),
      ],
    });

    await expect(client.training.hrZones.query({ days: 30 })).resolves.toEqual(hrZones);
    await expect(client.efficiency.polarizationTrend.query({ days: 30 })).resolves.toEqual(
      polarizationTrend,
    );
    await expect(client.cyclingAdvanced.trainingMonotony.query({ days: 30 })).resolves.toEqual([]);
    await expect(
      client.mobileDashboard.recovery.query({ days: 30, endDate: "2026-07-28" }),
    ).rejects.toThrow("Unhandled processing-status story tRPC operation: mobileDashboard.recovery");
  });
});
