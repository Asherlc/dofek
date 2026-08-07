import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { sql } from "drizzle-orm";
import { drizzle, type NodePgClient, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { z } from "zod";
import { executeWithSchema } from "../src/db/typed-sql.ts";
import { decryptCredentialValue } from "../src/security/credential-encryption.ts";
import { slackCredentialContext } from "../src/security/slack-credential-context.ts";

const advisoryLockName = "dofek.slack_team_membership_backfill";
const slackApiBaseUrl = "https://slack.com/api";

const installationRowSchema = z.object({
  bot_token: z.string().min(1),
  installer_slack_user_id: z.string().min(1).nullable(),
  team_id: z.string().min(1),
});
const authAccountRowSchema = z.object({
  slack_user_id: z.string().min(1),
  user_id: z.uuid(),
});
const membershipRowSchema = z.object({
  slack_user_id: z.string().min(1),
  team_id: z.string().min(1),
  user_id: z.uuid(),
});
const advisoryLockRowSchema = z.object({ locked: z.boolean() });
const authTestResponseSchema = z.discriminatedUnion("ok", [
  z.object({ error: z.string().optional(), ok: z.literal(false) }),
  z.object({ ok: z.literal(true), team_id: z.string().min(1) }),
]);
const usersInfoResponseSchema = z.discriminatedUnion("ok", [
  z.object({ error: z.string().optional(), ok: z.literal(false) }),
  z.object({
    ok: z.literal(true),
    user: z.object({
      enterprise_user: z
        .object({
          teams: z.array(z.string().min(1)).optional(),
        })
        .optional(),
      id: z.string().min(1),
      is_stranger: z.boolean().optional(),
      team_id: z.string().min(1).optional(),
      teams: z.array(z.string().min(1)).optional(),
    }),
  }),
]);

type BackfillClient = NodePgClient;
type BackfillDatabase = NodePgDatabase<Record<string, never>>;

interface SlackDatabaseState {
  accounts: z.infer<typeof authAccountRowSchema>[];
  installations: z.infer<typeof installationRowSchema>[];
  memberships: z.infer<typeof membershipRowSchema>[];
}

interface DecryptedInstallation {
  botToken: string;
  installerSlackUserId: string | null;
  teamId: string;
}

interface MembershipAssignment {
  slackUserId: string;
  teamId: string;
  userId: string;
}

export interface SlackTeamMembershipBackfillResult {
  identitiesChecked: number;
  installationsVerified: number;
  membershipsAlreadyPresent: number;
  membershipsDiscovered: number;
  membershipsInserted: number;
}

export interface SlackTeamMembershipBackfillOptions {
  execute: boolean;
}

class SlackTeamMembershipBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackTeamMembershipBackfillError";
  }
}

function safeError(message: string): SlackTeamMembershipBackfillError {
  return new SlackTeamMembershipBackfillError(message);
}

function pairKey(first: string, second: string): string {
  return `${first}\u0000${second}`;
}

function identityKey(userId: string, slackUserId: string): string {
  return pairKey(userId, slackUserId);
}

function stateFingerprint(state: SlackDatabaseState): string {
  return JSON.stringify(state);
}

function textArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;
}

function uuidArray(values: string[]) {
  return sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}::uuid`),
    sql`, `,
  )}]::uuid[]`;
}

async function readDatabaseState(database: BackfillDatabase): Promise<SlackDatabaseState> {
  const installations = await executeWithSchema(
    database,
    installationRowSchema,
    sql`SELECT team_id, bot_token, installer_slack_user_id
        FROM fitness.slack_installation
        ORDER BY team_id`,
  );
  const accounts = await executeWithSchema(
    database,
    authAccountRowSchema,
    sql`SELECT user_id::text AS user_id, provider_account_id AS slack_user_id
        FROM fitness.auth_account
        WHERE auth_provider = 'slack'
        ORDER BY provider_account_id, user_id`,
  );
  const memberships = await executeWithSchema(
    database,
    membershipRowSchema,
    sql`SELECT team_id, user_id::text AS user_id, slack_user_id
        FROM fitness.slack_team_membership
        ORDER BY team_id, user_id, slack_user_id`,
  );

  return {
    accounts,
    installations,
    memberships,
  };
}

async function decryptInstallations(
  rows: SlackDatabaseState["installations"],
): Promise<DecryptedInstallation[]> {
  try {
    return await Promise.all(
      rows.map(async (row) => ({
        botToken: await decryptCredentialValue(
          row.bot_token,
          slackCredentialContext(row.team_id, "bot_token"),
        ),
        installerSlackUserId: row.installer_slack_user_id,
        teamId: row.team_id,
      })),
    );
  } catch {
    throw safeError(
      "Slack membership backfill could not decrypt an installation token; repair credential configuration before rollout",
    );
  }
}

async function postSlackMethod(
  method: "auth.test" | "users.info",
  token: string,
  body?: URLSearchParams,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${slackApiBaseUrl}/${method}`, {
      body,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw safeError(
      "Slack membership backfill could not reach the Slack API; restore access and rerun",
    );
  }

  if (!response.ok) {
    throw safeError(
      response.status === 429
        ? "Slack membership backfill was rate limited; wait for the Retry-After interval and rerun"
        : "Slack membership backfill received an unsuccessful Slack API response; restore access and rerun",
    );
  }

  try {
    return await response.json();
  } catch {
    throw safeError(
      "Slack membership backfill received an invalid Slack API response; stop rollout and investigate",
    );
  }
}

async function verifyInstallation(installation: DecryptedInstallation): Promise<void> {
  const parsed = authTestResponseSchema.safeParse(
    await postSlackMethod("auth.test", installation.botToken),
  );
  if (!parsed.success || !parsed.data.ok) {
    throw safeError(
      "Slack membership backfill could not verify an installation token; reinstall or repair the Slack app before rollout",
    );
  }
  if (parsed.data.team_id !== installation.teamId) {
    throw safeError(
      "Slack membership backfill found an installation token assigned to the wrong workspace; repair the stored installation before rollout",
    );
  }
}

async function isAuthoritativeWorkspaceMember(
  installation: DecryptedInstallation,
  slackUserId: string,
): Promise<boolean> {
  const parsed = usersInfoResponseSchema.safeParse(
    await postSlackMethod(
      "users.info",
      installation.botToken,
      new URLSearchParams({ user: slackUserId }),
    ),
  );
  if (!parsed.success) {
    throw safeError(
      "Slack membership backfill received an invalid users.info response; stop rollout and investigate",
    );
  }
  if (!parsed.data.ok) {
    if (parsed.data.error === "user_not_found") {
      return false;
    }
    if (parsed.data.error === "missing_scope") {
      throw safeError(
        "Slack membership backfill requires users:read on every installation token; reinstall the Slack app before rollout",
      );
    }
    throw safeError(
      "Slack membership backfill could not authoritatively resolve a Slack identity; repair Slack API access before rollout",
    );
  }

  if (parsed.data.user.id !== slackUserId) {
    throw safeError(
      "Slack membership backfill received a mismatched users.info identity; stop rollout and investigate",
    );
  }

  const workspaceIds = new Set<string>();
  if (parsed.data.user.team_id) {
    workspaceIds.add(parsed.data.user.team_id);
  }
  for (const teamId of parsed.data.user.teams ?? []) {
    workspaceIds.add(teamId);
  }
  for (const teamId of parsed.data.user.enterprise_user?.teams ?? []) {
    workspaceIds.add(teamId);
  }
  if (workspaceIds.size === 0) {
    throw safeError(
      "Slack membership backfill received users.info data without a workspace membership; stop rollout and investigate",
    );
  }

  return parsed.data.user.is_stranger !== true && workspaceIds.has(installation.teamId);
}

function addAssignment(
  assignment: MembershipAssignment,
  assignmentsByTeamIdentity: Map<string, MembershipAssignment>,
  assignmentsByTeamUser: Map<string, MembershipAssignment>,
  existingByTeamIdentity: ReadonlyMap<string, z.infer<typeof membershipRowSchema>>,
  existingByTeamUser: ReadonlyMap<string, z.infer<typeof membershipRowSchema>>,
): void {
  const teamIdentityKey = pairKey(assignment.teamId, assignment.slackUserId);
  const teamUserKey = pairKey(assignment.teamId, assignment.userId);
  const existingIdentity = existingByTeamIdentity.get(teamIdentityKey);
  const existingUser = existingByTeamUser.get(teamUserKey);
  if (
    (existingIdentity && existingIdentity.user_id !== assignment.userId) ||
    (existingUser && existingUser.slack_user_id !== assignment.slackUserId)
  ) {
    throw safeError(
      "Slack membership backfill found conflicting team-qualified identity data; provide an explicit authoritative mapping before rollout",
    );
  }
  if (
    existingIdentity?.user_id === assignment.userId &&
    existingUser?.slack_user_id === assignment.slackUserId
  ) {
    return;
  }

  const candidateIdentity = assignmentsByTeamIdentity.get(teamIdentityKey);
  const candidateUser = assignmentsByTeamUser.get(teamUserKey);
  if (
    (candidateIdentity && candidateIdentity.userId !== assignment.userId) ||
    (candidateUser && candidateUser.slackUserId !== assignment.slackUserId)
  ) {
    throw safeError(
      "Slack membership backfill found an ambiguous identity; provide an explicit team-qualified mapping before rollout",
    );
  }

  assignmentsByTeamIdentity.set(teamIdentityKey, assignment);
  assignmentsByTeamUser.set(teamUserKey, assignment);
}

async function discoverAssignments(
  state: SlackDatabaseState,
  installations: DecryptedInstallation[],
): Promise<MembershipAssignment[]> {
  const accountsBySlackUserId = new Map(
    state.accounts.map((account) => [account.slack_user_id, account]),
  );
  const existingByTeamIdentity = new Map(
    state.memberships.map((membership) => [
      pairKey(membership.team_id, membership.slack_user_id),
      membership,
    ]),
  );
  const existingByTeamUser = new Map(
    state.memberships.map((membership) => [
      pairKey(membership.team_id, membership.user_id),
      membership,
    ]),
  );
  const existingTeamsByIdentity = new Map<string, Set<string>>();
  for (const membership of state.memberships) {
    const account = accountsBySlackUserId.get(membership.slack_user_id);
    if (!account || account.user_id !== membership.user_id) {
      continue;
    }
    const key = identityKey(account.user_id, account.slack_user_id);
    const teams = existingTeamsByIdentity.get(key) ?? new Set<string>();
    teams.add(membership.team_id);
    existingTeamsByIdentity.set(key, teams);
  }

  const assignmentsByTeamIdentity = new Map<string, MembershipAssignment>();
  const assignmentsByTeamUser = new Map<string, MembershipAssignment>();
  const recordedTeamsByIdentity = new Map<string, Set<string>>();
  for (const installation of installations) {
    if (!installation.installerSlackUserId) {
      continue;
    }
    const account = accountsBySlackUserId.get(installation.installerSlackUserId);
    if (!account) {
      continue;
    }
    const assignment = {
      slackUserId: account.slack_user_id,
      teamId: installation.teamId,
      userId: account.user_id,
    };
    addAssignment(
      assignment,
      assignmentsByTeamIdentity,
      assignmentsByTeamUser,
      existingByTeamIdentity,
      existingByTeamUser,
    );
    const key = identityKey(account.user_id, account.slack_user_id);
    const teams = recordedTeamsByIdentity.get(key) ?? new Set<string>();
    teams.add(installation.teamId);
    recordedTeamsByIdentity.set(key, teams);
  }

  for (const account of state.accounts) {
    const key = identityKey(account.user_id, account.slack_user_id);
    const establishedTeams = new Set([
      ...(existingTeamsByIdentity.get(key) ?? []),
      ...(recordedTeamsByIdentity.get(key) ?? []),
    ]);
    const apiTeams = new Set<string>();

    for (const installation of installations) {
      const teamIdentityKey = pairKey(installation.teamId, account.slack_user_id);
      const teamUserKey = pairKey(installation.teamId, account.user_id);
      if (
        existingByTeamIdentity.has(teamIdentityKey) ||
        existingByTeamUser.has(teamUserKey) ||
        assignmentsByTeamIdentity.has(teamIdentityKey) ||
        assignmentsByTeamUser.has(teamUserKey)
      ) {
        continue;
      }
      if (await isAuthoritativeWorkspaceMember(installation, account.slack_user_id)) {
        apiTeams.add(installation.teamId);
      }
    }

    const allTeams = new Set([...establishedTeams, ...apiTeams]);
    if (apiTeams.size > 1 || (apiTeams.size === 1 && allTeams.size > 1)) {
      throw safeError(
        "Slack membership backfill found an ambiguous identity; provide an explicit team-qualified mapping before rollout",
      );
    }

    for (const teamId of apiTeams) {
      addAssignment(
        { slackUserId: account.slack_user_id, teamId, userId: account.user_id },
        assignmentsByTeamIdentity,
        assignmentsByTeamUser,
        existingByTeamIdentity,
        existingByTeamUser,
      );
    }
  }

  return [...assignmentsByTeamIdentity.values()].sort(
    (left, right) =>
      left.teamId.localeCompare(right.teamId) ||
      left.userId.localeCompare(right.userId) ||
      left.slackUserId.localeCompare(right.slackUserId),
  );
}

function isAccountErasureFenceError(error: unknown): boolean {
  let candidate: unknown = error;
  while (candidate !== null && typeof candidate === "object") {
    const record = z
      .object({
        cause: z.unknown().optional(),
        code: z.string().optional(),
      })
      .passthrough()
      .safeParse(candidate);
    if (!record.success) {
      return false;
    }
    if (record.data.code === "55000") {
      return true;
    }
    candidate = record.data.cause;
  }
  return false;
}

async function writeAssignments(
  database: BackfillDatabase,
  expectedState: SlackDatabaseState,
  assignments: MembershipAssignment[],
): Promise<number> {
  await database.execute(sql`BEGIN`);
  try {
    await database.execute(
      sql`LOCK TABLE fitness.auth_account IN SHARE MODE;
          LOCK TABLE fitness.slack_installation IN SHARE MODE;
          LOCK TABLE fitness.slack_team_membership IN SHARE ROW EXCLUSIVE MODE`,
    );
    const lockedState = await readDatabaseState(database);
    if (stateFingerprint(lockedState) !== stateFingerprint(expectedState)) {
      throw safeError(
        "Slack installation or identity state changed during preflight; rerun the backfill",
      );
    }

    let inserted = 0;
    if (assignments.length > 0) {
      const result = await executeWithSchema(
        database,
        z.object({ team_id: z.string().min(1) }),
        sql`INSERT INTO fitness.slack_team_membership (
              team_id, user_id, slack_user_id
            )
            SELECT assignment.team_id, assignment.user_id, assignment.slack_user_id
            FROM unnest(
              ${textArray(assignments.map((assignment) => assignment.teamId))},
              ${uuidArray(assignments.map((assignment) => assignment.userId))},
              ${textArray(assignments.map((assignment) => assignment.slackUserId))}
            ) AS assignment(team_id, user_id, slack_user_id)
            ON CONFLICT DO NOTHING
            RETURNING team_id`,
      );
      inserted = result.length;
      if (inserted !== assignments.length) {
        throw safeError(
          "Slack membership backfill write validation failed; stop rollout and investigate",
        );
      }
    }
    await database.execute(sql`COMMIT`);
    return inserted;
  } catch (error: unknown) {
    await database.execute(sql`ROLLBACK`);
    if (error instanceof SlackTeamMembershipBackfillError) {
      throw error;
    }
    if (isAccountErasureFenceError(error)) {
      throw safeError(
        "An account-erasure fence rejected the Slack membership backfill; resolve the active request before rollout",
      );
    }
    throw safeError(
      "Slack membership backfill could not persist its verified assignments; stop rollout and investigate",
    );
  }
}

export async function backfillSlackTeamMemberships(
  client: BackfillClient,
  options: SlackTeamMembershipBackfillOptions,
): Promise<SlackTeamMembershipBackfillResult> {
  const database = drizzle(client);
  const lockRows = await executeWithSchema(
    database,
    advisoryLockRowSchema,
    sql`SELECT pg_try_advisory_lock(hashtext(${advisoryLockName})) AS locked`,
  );
  if (lockRows[0]?.locked !== true) {
    throw safeError(
      "Another Slack membership backfill is active; wait for it to finish before rerunning",
    );
  }

  try {
    const state = await readDatabaseState(database);
    const installations = await decryptInstallations(state.installations);
    for (const installation of installations) {
      await verifyInstallation(installation);
    }
    const assignments = await discoverAssignments(state, installations);
    const inserted = options.execute ? await writeAssignments(database, state, assignments) : 0;

    return {
      identitiesChecked: state.accounts.length,
      installationsVerified: installations.length,
      membershipsAlreadyPresent: state.memberships.length,
      membershipsDiscovered: assignments.length,
      membershipsInserted: inserted,
    };
  } finally {
    await executeWithSchema(
      database,
      z.object({}),
      sql`SELECT pg_advisory_unlock(hashtext(${advisoryLockName}))`,
    );
  }
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const unknownArguments = args.filter((argument) => argument !== "--execute");
  if (unknownArguments.length > 0) {
    throw safeError("Unknown option; only --execute is supported");
  }
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw safeError("DATABASE_URL is required for the Slack membership backfill");
  }

  const execute = args.includes("--execute");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await backfillSlackTeamMemberships(client, { execute });
    console.log(
      `[slack-team-membership-backfill] verified ${result.installationsVerified} installations and ${result.identitiesChecked} identities; ${result.membershipsDiscovered} memberships require backfill`,
    );
    if (execute) {
      console.log(
        `[slack-team-membership-backfill] inserted ${result.membershipsInserted} memberships`,
      );
    } else {
      console.log(
        "[slack-team-membership-backfill] dry run only; add --execute to update Postgres",
      );
    }
  } finally {
    await client.end();
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  main().catch(async (error: unknown) => {
    const reportedError =
      error instanceof SlackTeamMembershipBackfillError
        ? error
        : safeError("Slack membership backfill failed unexpectedly; stop rollout and investigate");
    Sentry.captureException(reportedError, {
      tags: { operation: "slack-team-membership-backfill" },
    });
    console.error(`[slack-team-membership-backfill] ${reportedError.message}`);
    await Sentry.close(2_000);
    process.exitCode = 1;
  });
}
