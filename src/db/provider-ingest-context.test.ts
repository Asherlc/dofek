import { describe, expect, it } from "vitest";
import {
  getProviderIngestContext,
  runWithProviderIngestContext,
  runWithProviderUserIngestContext,
} from "./provider-ingest-context.ts";
import { getTokenUserId } from "./token-user-context.ts";

describe("provider ingest context", () => {
  it("scopes the home timezone to the current asynchronous ingest run", async () => {
    expect(getProviderIngestContext()).toBeUndefined();

    await runWithProviderIngestContext({ homeTimezone: "America/Los_Angeles" }, async () => {
      await Promise.resolve();
      expect(getProviderIngestContext()).toEqual({ homeTimezone: "America/Los_Angeles" });
    });

    expect(getProviderIngestContext()).toBeUndefined();
  });

  it("scopes the token user and ingest settings together", async () => {
    await runWithProviderUserIngestContext(
      "user-1",
      { homeTimezone: "America/Los_Angeles" },
      async () => {
        expect(getTokenUserId()).toBe("user-1");
        expect(getProviderIngestContext()?.homeTimezone).toBe("America/Los_Angeles");
      },
    );
  });
});
