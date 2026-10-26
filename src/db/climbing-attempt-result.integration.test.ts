import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, escapeIdentifier } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const migrationDirectory = resolve(import.meta.dirname, "../../drizzle");
const legacyProjection = readFileSync(
  resolve(migrationDirectory, "0147_climbing_log_model_finalize.sql"),
  "utf8",
).split("CREATE VIEW fitness.v_climbing_log_entry AS")[1];

describe("computed climbing attempt results (integration)", () => {
  let client: Client;
  let cleanup: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    const adminUrl = process.env.TEST_DATABASE_URL?.trim();
    if (!adminUrl) throw new Error("TEST_DATABASE_URL is required for climbing result tests.");
    const databaseName = `dofek_climb_result_${randomUUID().replaceAll("-", "")}`;
    const admin = new Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      await admin.query(`CREATE DATABASE ${escapeIdentifier(databaseName)}`);
    } finally {
      await admin.end();
    }
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    client = new Client({ connectionString: databaseUrl.toString() });
    cleanup = async () => {
      await client.end();
      const drop = new Client({ connectionString: adminUrl });
      await drop.connect();
      try {
        await drop.query(`DROP DATABASE ${escapeIdentifier(databaseName)}`);
      } finally {
        await drop.end();
      }
    };
    await client.connect();
    // The small pre-upgrade graph exercises this migration without replaying
    // unrelated schema history or any historical sensor backfills.
    await client.query(`
      CREATE SCHEMA fitness;
      CREATE TYPE fitness.attempt_outcome AS ENUM ('completed', 'failed');
      CREATE TABLE fitness.area (
        id uuid PRIMARY KEY, user_id uuid, provider_id text, name text,
        external_id text, parent_area_id uuid, coordinates point
      );
      CREATE TABLE fitness.climb (
        id uuid PRIMARY KEY, name text, kind text, setting text,
        route_protection text[], coordinates point, area_id uuid
      );
      CREATE TABLE fitness.climbing_log_entry (
        id uuid PRIMARY KEY, user_id uuid, provider_id text, external_id text,
        climb_id uuid, activity_id uuid, climbed_on date, discipline text,
        title text, notes text, board jsonb, wall_angle jsonb, hold_type text,
        source_name text, raw jsonb, provider_absent_at timestamptz,
        created_at timestamptz DEFAULT now()
      );
      CREATE TABLE fitness.climb_grade (climb_id uuid, value text, system text, position bigint);
      CREATE TABLE fitness.climbing_log_entry_grade (
        climbing_log_entry_id uuid, value text, system text, position bigint
      );
      CREATE TABLE fitness.climbing_attempt (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), climbing_log_entry_id uuid NOT NULL,
        scope text NOT NULL, pitch_id uuid, parent_attempt_id uuid, attempt_index bigint,
        outcome fitness.attempt_outcome, rope_method text, solo boolean,
        protection_used text[], used_preplaced_protection boolean, used_aid boolean,
        fell_or_hung boolean, dabbed boolean, received_beta boolean,
        had_completed_before boolean, prior_failed_attempts_ground_up boolean,
        notes text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE VIEW fitness.v_climbing_log_entry AS ${legacyProjection}
    `);
  });

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  async function migrate() {
    await client.query("BEGIN");
    let committed = false;
    try {
      const sql = readFileSync(
        resolve(migrationDirectory, "0148_compute_climbing_attempt_outcome.sql"),
        "utf8",
      );
      for (const statement of sql.split("--> statement-breakpoint")) {
        if (statement.trim()) await client.query(statement);
      }
      await client.query("COMMIT");
      committed = true;
    } finally {
      if (!committed) await client.query("ROLLBACK");
    }
  }

  async function seedLog(provider: string, raw: Record<string, unknown>, kind = "route") {
    const id = randomUUID();
    const climbId = randomUUID();
    await client.query("INSERT INTO fitness.climb (id, kind) VALUES ($1, $2)", [climbId, kind]);
    await client.query(
      `INSERT INTO fitness.climbing_log_entry (id, provider_id, raw, climb_id, discipline)
       VALUES ($1, $2, $3, $4, 'rock_climbing')`,
      [id, provider, raw, climbId],
    );
    return id;
  }

  async function seedAttempt(
    logId: string,
    outcome: "completed" | "failed" | null,
    options: { scope?: string; fellOrHung?: boolean; usedAid?: boolean } = {},
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO fitness.climbing_attempt (
         id, climbing_log_entry_id, scope, outcome, fell_or_hung, used_aid
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, logId, options.scope ?? "climb", outcome, options.fellOrHung, options.usedAid],
    );
    return id;
  }

  it("computes completion from raw result labels without treating Fell/Hung or rope method as failure", async () => {
    await migrate();
    const completed = [
      "completed",
      "sent",
      "on sight",
      "onsight",
      "aid onsight",
      "flash",
      "aid flash",
      "clean",
      "send",
      "redpoint",
      "pinkpoint",
      "greenpoint",
      "repeat",
      "ground-up redpoint",
      "dog",
      "hang dog",
      "tick",
      "dab",
      " rEdPoInT ",
      "\tFlash\n",
      "\u00a0Redpoint\ufeff",
    ];
    const failed = ["attempt", "failed", " FAILED "];
    const unknown = [null, "", "Fell/Hung", "TR", "Lead", "future-source-label"];
    const labels = [...completed, ...failed, ...unknown];
    const results = await client.query(
      `SELECT fitness.climbing_attempt_outcome(label) AS outcome FROM unnest($1::text[]) AS label`,
      [labels],
    );
    expect(results.rows).toEqual([
      ...completed.map(() => ({ outcome: "completed" })),
      ...failed.map(() => ({ outcome: "failed" })),
      ...unknown.map(() => ({ outcome: null })),
    ]);
  });

  it("preserves each exact source label on its described occurrence and leaves count-expanded occurrences unknown", async () => {
    const sources = [
      {
        provider: "mountain-project",
        raw: { "Lead Style": " rEdPoInT ", Style: "Lead" },
        label: " rEdPoInT ",
      },
      { provider: "mountain-project", raw: { Style: "Send" }, label: "Send", kind: "boulder" },
      { provider: "openbeta", raw: { attemptType: "\tFlash\n" }, label: "\tFlash\n" },
      { provider: "thecrag", raw: { ascent: { tick: { label: "Dog" } } }, label: "Dog" },
      { provider: "thecrag", raw: { ascent: { tick: { name: "Tick" } } }, label: "Tick" },
      {
        provider: "thecrag",
        raw: { ascent: { tick: { label: "\t", name: "\u00a0Tick\ufeff" } } },
        label: "\u00a0Tick\ufeff",
      },
      { provider: "kaya", raw: { ascent_type: { name: "Redpoint" } }, label: "Redpoint" },
      { provider: "kaya-export", raw: { ascentType: "Repeat" }, label: "Repeat" },
    ];
    const expected = [];
    for (const source of sources) {
      const log = await seedLog(source.provider, source.raw, source.kind);
      const described = await seedAttempt(log, "completed");
      const anonymous = await seedAttempt(log, null);
      expected.push(
        { id: described, source_result: source.label, outcome: "completed" },
        { id: anonymous, source_result: null, outcome: null },
      );
    }
    const failedLog = await seedLog("thecrag", { ascent: { tick: { label: "Attempt" } } });
    expected.push({
      id: await seedAttempt(failedLog, "failed"),
      source_result: "Attempt",
      outcome: "failed",
    });
    await migrate();
    const results = await client.query(
      "SELECT id, source_result, outcome FROM fitness.v_climbing_attempt",
    );
    expect(results.rows).toHaveLength(expected.length);
    expect(results.rows).toEqual(expect.arrayContaining(expected));
  });

  it("preserves unambiguous Fell/Hung evidence without assigning it to anonymous occurrences", async () => {
    const log = await seedLog("openbeta", { attemptType: "Fell/Hung" });
    const described = await seedAttempt(log, null, { fellOrHung: true });
    const anonymous = [await seedAttempt(log, null), await seedAttempt(log, null)];
    const trLog = await seedLog("mountain-project", { Style: "TR", "Lead Style": "" });
    const tr = await seedAttempt(trLog, null);
    await migrate();
    const results = await client.query(
      "SELECT id, source_result, outcome FROM fitness.v_climbing_attempt",
    );
    expect(results.rows).toEqual(
      expect.arrayContaining([
        { id: described, source_result: "Fell/Hung", outcome: null },
        ...[...anonymous, tr].map((id) => ({ id, source_result: null, outcome: null })),
      ]),
    );
    const projection = await client.query(
      `SELECT recorded_climb_attempt_count::int, recorded_climb_outcome, free_send
       FROM fitness.v_climbing_log_entry WHERE id = $1`,
      [log],
    );
    expect(projection.rows).toEqual([
      { recorded_climb_attempt_count: 3, recorded_climb_outcome: null, free_send: null },
    ]);
  });

  it("recomputes attempt and whole-climb results from current source facts at read time", async () => {
    await migrate();
    const log = await seedLog("openbeta", { attemptType: "Flash" });
    const id = randomUUID();
    await client.query(
      `INSERT INTO fitness.climbing_attempt (id, climbing_log_entry_id, scope, source_result, fell_or_hung, used_aid)
       VALUES ($1, $2, 'climb', 'Flash', false, false)`,
      [id, log],
    );
    for (const [label, outcome, freeSend] of [
      ["Flash", "completed", true],
      ["Attempt", "failed", false],
      ["Fell/Hung", null, null],
    ]) {
      await client.query("UPDATE fitness.climbing_attempt SET source_result = $1 WHERE id = $2", [
        label,
        id,
      ]);
      const attempts = await client.query(
        "SELECT outcome FROM fitness.v_climbing_attempt WHERE id = $1",
        [id],
      );
      expect(attempts.rows).toEqual([{ outcome }]);
      const logs = await client.query(
        "SELECT recorded_climb_outcome, free_send FROM fitness.v_climbing_log_entry WHERE id = $1",
        [log],
      );
      expect(logs.rows).toEqual([{ recorded_climb_outcome: outcome, free_send: freeSend }]);
    }
    await expect(
      client.query("UPDATE fitness.climbing_attempt SET source_result = ' ' WHERE id = $1", [id]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "climbing_attempt_source_result_nonempty",
    });
    await expect(
      client.query("UPDATE fitness.climbing_attempt SET source_result = $1 WHERE id = $2", [
        "\t\n\u00a0\ufeff",
        id,
      ]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "climbing_attempt_source_result_nonempty",
    });
  });

  it.each(["missing", "conflicting", "ambiguous", "pitch"] as const)(
    "rejects %s raw evidence before losing an existing result",
    async (scenario) => {
      const raw =
        scenario === "missing"
          ? {}
          : { attemptType: scenario === "conflicting" ? "Fell/Hung" : "Flash" };
      const log = await seedLog("openbeta", raw);
      const id = await seedAttempt(log, "completed", {
        scope: scenario === "pitch" ? "pitch" : "climb",
      });
      if (scenario === "ambiguous") await seedAttempt(log, "completed");
      await expect(migrate()).rejects.toThrow(/retained source result/i);
      const retained = await client.query(
        "SELECT outcome FROM fitness.climbing_attempt WHERE id = $1",
        [id],
      );
      expect(retained.rows).toEqual([{ outcome: "completed" }]);
    },
  );
  describe("provider completion projection", () => {
    beforeEach(async () => {
      await migrate();
    });

    async function applyCompletionProjection() {
      await client.query(
        readFileSync(
          resolve(migrationDirectory, "0165_mountain_project_top_rope_completion.sql"),
          "utf8",
        ),
      );
      await client.query(
        readFileSync(resolve(migrationDirectory, "0166_openbeta_tick_completion.sql"), "utf8"),
      );
    }

    async function insertRecordedAttempt(
      provider: string,
      options: {
        ropeMethod?: string;
        sourceResult?: string;
        fellOrHung?: boolean;
        usedAid?: boolean;
        dabbed?: boolean;
        kind?: string;
        scope?: string;
        raw?: Record<string, unknown>;
      } = {},
    ) {
      const logId = await seedLog(
        provider,
        options.raw ?? { Style: options.ropeMethod === "lead" ? "Lead" : "TR" },
        options.kind ?? "route",
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO fitness.climbing_attempt (id, climbing_log_entry_id, scope, rope_method, source_result, fell_or_hung, used_aid, dabbed)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          logId,
          options.scope ?? "climb",
          options.ropeMethod ?? "top_rope",
          options.sourceResult,
          options.fellOrHung,
          options.usedAid,
          options.dabbed,
        ],
      );
      return { id, logId };
    }

    it("projects a clean completed top-rope climb without changing retained raw facts", async () => {
      const { id, logId } = await insertRecordedAttempt("mountain-project");
      await applyCompletionProjection();
      const projected = await client.query(
        "SELECT outcome, used_aid, fell_or_hung, source_result FROM fitness.v_climbing_attempt WHERE id = $1",
        [id],
      );
      expect(projected.rows).toEqual([
        { outcome: "completed", used_aid: false, fell_or_hung: false, source_result: null },
      ]);
      const log = await client.query(
        "SELECT recorded_climb_outcome, free_send FROM fitness.v_climbing_log_entry WHERE id = $1",
        [logId],
      );
      expect(log.rows).toEqual([{ recorded_climb_outcome: "completed", free_send: true }]);
      const retained = await client.query(
        "SELECT source_result, used_aid, fell_or_hung FROM fitness.climbing_attempt WHERE id = $1",
        [id],
      );
      expect(retained.rows).toEqual([{ source_result: null, used_aid: null, fell_or_hung: null }]);
    });

    it.each([
      {
        sourceResult: "Fell/Hung",
        fellOrHung: true,
        expectedOutcome: null,
        expectedFreeSend: false,
        expectedAid: null,
      },
      {
        sourceResult: "Failed",
        expectedOutcome: "failed",
        expectedFreeSend: false,
        expectedAid: null,
      },
      {
        sourceResult: "Flash",
        expectedOutcome: "completed",
        expectedFreeSend: null,
        expectedAid: null,
      },
      {
        fellOrHung: true,
        expectedOutcome: "completed",
        expectedFreeSend: false,
        expectedAid: false,
      },
      { usedAid: true, expectedOutcome: "completed", expectedFreeSend: false, expectedAid: true },
    ])("preserves explicit result and execution facts: %j", async (scenario) => {
      const { id, logId } = await insertRecordedAttempt("mountain-project", scenario);
      await applyCompletionProjection();
      const projected = await client.query(
        "SELECT outcome, used_aid, fell_or_hung FROM fitness.v_climbing_attempt WHERE id = $1",
        [id],
      );
      expect(projected.rows).toEqual([
        {
          outcome: scenario.expectedOutcome,
          used_aid: scenario.expectedAid,
          fell_or_hung: scenario.fellOrHung ?? (scenario.sourceResult ? null : false),
        },
      ]);
      const log = await client.query(
        "SELECT free_send FROM fitness.v_climbing_log_entry WHERE id = $1",
        [logId],
      );
      expect(log.rows).toEqual([{ free_send: scenario.expectedFreeSend }]);
    });

    it.each([
      { provider: "mountain-project", ropeMethod: "lead" },
      { provider: "kaya", ropeMethod: "top_rope" },
      { provider: "mountain-project", ropeMethod: "top_rope", scope: "pitch" },
      { provider: "mountain-project", ropeMethod: "top_rope", kind: "boulder" },
    ])(
      "keeps unsupported provider/kind/scope/method unknown: %j",
      async ({ provider, ...options }) => {
        const { id } = await insertRecordedAttempt(provider, options);
        await applyCompletionProjection();
        const projected = await client.query(
          "SELECT outcome, used_aid, fell_or_hung FROM fitness.v_climbing_attempt WHERE id = $1",
          [id],
        );
        expect(projected.rows).toEqual([{ outcome: null, used_aid: null, fell_or_hung: null }]);
      },
    );

    it.each([
      {
        raw: {},
        kind: "boulder",
        ropeMethod: "unroped",
        expectedOutcome: "completed",
        expectedFreeSend: true,
      },
      { raw: {}, ropeMethod: "lead", expectedOutcome: "completed", expectedFreeSend: true },
      {
        raw: {},
        kind: "boulder",
        dabbed: true,
        expectedOutcome: "completed",
        expectedFreeSend: false,
      },
      { raw: {}, sourceResult: "Attempt", expectedOutcome: "failed", expectedFreeSend: false },
      { raw: {}, scope: "pitch", expectedOutcome: null, expectedFreeSend: null },
      { raw: {}, expectedOutcome: "completed", expectedFreeSend: true },
      { raw: { attemptType: null }, expectedOutcome: "completed", expectedFreeSend: true },
      { raw: { attemptType: "Attempt" }, expectedOutcome: "failed", expectedFreeSend: false },
      { raw: { attemptType: " aTtEmPt " }, expectedOutcome: "failed", expectedFreeSend: false },
      {
        raw: { attemptType: "Flash" },
        sourceResult: "Flash",
        expectedOutcome: "completed",
        expectedFreeSend: null,
      },
      {
        raw: { attemptType: "Fell/Hung" },
        sourceResult: "Fell/Hung",
        fellOrHung: true,
        expectedOutcome: null,
        expectedFreeSend: false,
      },
      { raw: {}, fellOrHung: true, expectedOutcome: "completed", expectedFreeSend: false },
      { raw: {}, usedAid: true, expectedOutcome: "completed", expectedFreeSend: false },
      { raw: { attemptType: "future-label" }, expectedOutcome: null, expectedFreeSend: null },
    ])("interprets retained OpenBeta tick facts: %j", async (scenario) => {
      const { id, logId } = await insertRecordedAttempt("openbeta", scenario);
      await applyCompletionProjection();
      const projected = await client.query(
        "SELECT outcome FROM fitness.v_climbing_attempt WHERE id = $1",
        [id],
      );
      expect(projected.rows).toEqual([{ outcome: scenario.expectedOutcome }]);
      const log = await client.query(
        "SELECT free_send FROM fitness.v_climbing_log_entry WHERE id = $1",
        [logId],
      );
      expect(log.rows).toEqual([{ free_send: scenario.expectedFreeSend }]);
      const retained = await client.query(
        "SELECT source_result, used_aid, fell_or_hung FROM fitness.climbing_attempt WHERE id = $1",
        [id],
      );
      expect(retained.rows).toEqual([
        {
          source_result: scenario.sourceResult ?? null,
          used_aid: scenario.usedAid ?? null,
          fell_or_hung: scenario.fellOrHung ?? null,
        },
      ]);
    });
  });
});
