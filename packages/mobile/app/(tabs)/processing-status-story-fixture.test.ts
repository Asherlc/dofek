import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { seedReadyProcessingStatus } from "./processing-status-story-fixture";

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
});
