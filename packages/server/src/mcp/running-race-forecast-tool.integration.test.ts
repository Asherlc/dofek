import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runningRaceResult } from "../../../../src/db/schema/activity.ts";
import { userProfile } from "../../../../src/db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { registerRunningRaceForecastTool } from "./running-race-forecast-tool.ts";

let context: TestContext;
beforeAll(async () => {
  context = await setupTestDatabase();
});
afterAll(async () => {
  await context?.cleanup();
});

it("chooses an exact, strictly shorter owner race by date and then stable source identity", async () => {
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const server = new McpServer({ name: "forecast-server", version: "1.0.0" });
  const client = new Client({ name: "forecast-client", version: "1.0.0" });
  try {
    await context.db.insert(userProfile).values([
      { id: userId, name: "Forecast user" },
      { id: otherUserId, name: "Other user" },
    ]);
    await ensureProvider(context.db, "runalyze", "Runalyze", undefined, userId);
    await ensureProvider(context.db, "second-source", "Second source", undefined, userId);
    const race = {
      userId,
      providerId: "runalyze",
      sourceActivityId: "01",
      sourceSport: "Running",
      sourceName: "Selected 5K",
      sourceDateTime: "2026-05-01T00:30:00+09:00",
      distanceMeters: 5000,
      finishSeconds: 1500,
    };
    await context.db.insert(runningRaceResult).values([
      race,
      { ...race, sourceActivityId: "02", sourceDateTime: "2026-05-01T23:30:00" },
      { ...race, providerId: "second-source", sourceActivityId: "00" },
      { ...race, sourceActivityId: "00", sourceDateTime: "2026-04-30T23:45:00-07:00" },
      { ...race, userId: otherUserId, sourceActivityId: "03", distanceMeters: 8046.72 },
      { ...race, sourceActivityId: "04", distanceMeters: 8046.721 },
      { ...race, sourceActivityId: "05", distanceMeters: 10000 },
      {
        ...race,
        sourceActivityId: "06",
        distanceMeters: 16093.44,
        sourceDateTime: "2026-04-30T10:00:00",
      },
      {
        ...race,
        sourceActivityId: "07",
        distanceMeters: 8046.72,
        sourceDateTime: "2999-05-01T12:00:00",
      },
    ]);
    registerRunningRaceForecastTool(server, {
      db: context.db,
      userId,
      clientId: "test-client",
      scopes: ["activity:read"],
      timezone: "America/Los_Angeles",
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const forecast = (target: string, start_date = "2026-04-30", end_date = "2999-05-01") =>
      client.callTool({
        name: "get_running_race_forecast",
        arguments: { target, start_date, end_date },
      });
    const tenKilometers = {
      result: {
        status: "estimated",
        source: {
          date: "2026-05-01",
          source_activity_id: "01",
          source_date_time: race.sourceDateTime,
          provider_id: "runalyze",
          distance_meters: 5000,
        },
      },
    };
    expect((await forecast("10k")).structuredContent).toMatchObject(tenKilometers);
    expect((await forecast("10k", "2026-05-01", "2026-05-01")).structuredContent).toMatchObject(
      tenKilometers,
    );
    expect((await forecast("half_marathon")).structuredContent).toMatchObject({
      result: {
        source: {
          source_activity_id: "06",
          source_date_time: "2026-04-30T10:00:00",
          distance_meters: 16093.44,
        },
      },
    });
    expect((await forecast("10k", "2026-05-02")).structuredContent).toMatchObject({
      result: { status: "unavailable" },
    });
  } finally {
    await client.close();
    await server.close();
  }
});
