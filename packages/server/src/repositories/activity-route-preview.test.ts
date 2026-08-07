import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { getActivityRoutePreviews } from "./activity-route-preview.ts";

describe("getActivityRoutePreviews", () => {
  it("requests enough sampled points for a detailed route preview", async () => {
    let capturedParams: Record<string, unknown> | undefined;
    const sensorStore = {
      query: async <TSchema extends z.ZodType>(
        _schema: TSchema,
        _query: string,
        params?: Record<string, unknown>,
      ): Promise<z.infer<TSchema>[]> => {
        capturedParams = params;
        return [];
      },
    };

    await getActivityRoutePreviews(sensorStore, "user-1", ["activity-1"]);

    expect(capturedParams).toMatchObject({ maxPoints: 96 });
  });
});
