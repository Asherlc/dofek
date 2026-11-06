/**
 * One-shot / idempotent bootstrap for Pulsar B2 offload Terraform auth.
 *
 * Root runs this with privately injected credentials. Never paste secret values
 * into chat, CI logs, or agent prompts. The existing Codex management key is
 * only read from env for this process and is never written to GH/Infisical/TF.
 *
 * Usage (from repo root, pulsar-foundation worktree):
 *   B2_MANAGEMENT_KEY_ID='…' B2_MANAGEMENT_KEY='…' \
 *     pnpm tsx scripts/bootstrap-b2-pulsar-offload-iac.ts
 *
 * Infisical auth: logged-in `infisical` CLI session, or INFISICAL_TOKEN.
 *
 * Does NOT run terraform apply or touch production Pulsar stack.
 */

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ZodType, z } from "zod";

const PROJECT_ID = "54712f56-98a9-4531-9e97-0b588d2e5a88";
const CI_IDENTITY_ID = "46b66f72-0c77-4cfe-be1b-a43395e77be7";
const ROLE_SLUG = "gha-pulsar-offload-b2-secrets";
const ROLE_NAME = "GHA Pulsar offload B2 secrets";
const IAC_KEY_NAME = "dofek-terraform-b2-iac";
const GH_SECRET_KEY_ID = "B2_APPLICATION_KEY_ID";
const GH_SECRET_KEY = "B2_APPLICATION_KEY";
const INFISICAL_API = "https://app.infisical.com/api";
const B2_AUTH_URL = "https://api.backblazeb2.com/b2api/v3/b2_authorize_account";

/** Account-scoped caps for the dedicated Terraform parent key (not the broker runtime key). */
export const B2_IAC_PARENT_CAPABILITIES = [
  "listKeys",
  "writeKeys",
  "deleteKeys",
  "listBuckets",
  "readBuckets",
  "writeBuckets",
  "deleteBuckets",
  "listFiles",
  "readFiles",
  "writeFiles",
  "deleteFiles",
] as const;

/** Infisical permissions_v2: only PULSAR_OFFLOAD_B2_* in prod at `/`. */
export function buildOffloadSecretRolePermissions(): Array<{
  subject: "secrets";
  action: string[];
  conditions: {
    environment: { $eq: string };
    secretPath: { $eq: string };
    secretName: { $glob: string };
  };
}> {
  return [
    {
      subject: "secrets",
      action: ["describeSecret", "readValue", "create", "edit"],
      conditions: {
        environment: { $eq: "prod" },
        secretPath: { $eq: "/" },
        secretName: { $glob: "PULSAR_OFFLOAD_B2_*" },
      },
    },
  ];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`ERROR: missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

const unknownJsonSchema = z.unknown();

async function httpJson<Schema extends ZodType>(
  url: string,
  schema: Schema,
  init: RequestInit = {},
  okStatuses: number[] = [200],
): Promise<{ status: number; body: z.infer<Schema> }> {
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = unknownJsonSchema.parse(JSON.parse(text));
  } catch {
    console.error(`ERROR: non-JSON response from ${url} status=${response.status}`);
    process.exit(1);
  }
  if (!okStatuses.includes(response.status)) {
    console.error(`ERROR: ${url} returned HTTP ${response.status}`);
    process.exit(1);
  }
  return { status: response.status, body: schema.parse(parsed) };
}

const b2AuthorizeSchema = z.object({
  accountId: z.string().min(1),
  apiInfo: z.object({
    storageApi: z.object({
      apiUrl: z.string().url(),
    }),
  }),
  authorizationToken: z.string().min(1),
  allowed: z
    .object({
      capabilities: z.array(z.string()).optional(),
    })
    .optional(),
});

const b2KeyListSchema = z.object({
  keys: z.array(
    z.object({
      keyName: z.string(),
      applicationKeyId: z.string(),
      capabilities: z.array(z.string()).optional().default([]),
    }),
  ),
});

const b2CreateKeySchema = z.object({
  keyName: z.string(),
  applicationKeyId: z.string().min(1),
  applicationKey: z.string().min(1),
  capabilities: z.array(z.string()).optional().default([]),
});

const b2DeleteKeySchema = z.object({}).passthrough();

const infisicalRolesSchema = z.object({
  roles: z.array(
    z.object({
      id: z.string().min(1),
      slug: z.string().min(1),
    }),
  ),
});

const infisicalRoleMutationSchema = z.object({}).passthrough();

const infisicalMembershipSchema = z.object({
  identityMembership: z
    .object({
      roles: z
        .array(
          z.object({
            role: z.string(),
            customRoleSlug: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

function getInfisicalToken(): string {
  if (process.env.INFISICAL_TOKEN) {
    return process.env.INFISICAL_TOKEN;
  }
  const result = spawnSync("infisical", ["user", "get", "token"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("ERROR: Infisical auth missing. Log in or set INFISICAL_TOKEN.");
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(1);
  }
  const line = (result.stdout ?? "")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("Token: ") || entry.startsWith("eyJ"));
  if (!line) {
    console.error("ERROR: could not parse Infisical user token");
    process.exit(1);
  }
  return line.startsWith("Token: ") ? line.slice("Token: ".length) : line;
}

function ghSecretNames(): Set<string> {
  const result = spawnSync("gh", ["secret", "list", "--json", "name", "-q", ".[].name"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("ERROR: gh secret list failed");
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(1);
  }
  return new Set(
    (result.stdout ?? "")
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function ghSecretSet(name: string, value: string): void {
  const result = spawnSync("gh", ["secret", "set", name], {
    encoding: "utf8",
    input: value,
  });
  if (result.status !== 0) {
    console.error(`ERROR: gh secret set ${name} failed`);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(1);
  }
}

async function ensureB2IacParentKey(
  managementKeyId: string,
  managementKey: string,
): Promise<{
  applicationKeyId: string;
  created: boolean;
  reused: boolean;
}> {
  const basic = Buffer.from(`${managementKeyId}:${managementKey}`).toString("base64");
  const auth = await httpJson(B2_AUTH_URL, b2AuthorizeSchema, {
    headers: { Authorization: `Basic ${basic}` },
  });
  const caps = new Set(auth.body.allowed?.capabilities ?? []);
  for (const needed of ["writeKeys", "listKeys", "deleteKeys"] as const) {
    if (caps.size > 0 && !caps.has(needed)) {
      console.error(`ERROR: management key missing capability ${needed}`);
      process.exit(1);
    }
  }

  const apiUrl = auth.body.apiInfo.storageApi.apiUrl;
  const accountId = auth.body.accountId;
  const token = auth.body.authorizationToken;

  const listed = await httpJson(`${apiUrl}/b2api/v3/b2_list_keys`, b2KeyListSchema, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accountId, maxKeyCount: 1000 }),
  });

  const existing = listed.body.keys.find((key) => key.keyName === IAC_KEY_NAME);
  const secretNames = ghSecretNames();
  const ghHasBoth = secretNames.has(GH_SECRET_KEY_ID) && secretNames.has(GH_SECRET_KEY);

  if (existing && ghHasBoth) {
    return { applicationKeyId: existing.applicationKeyId, created: false, reused: true };
  }

  if (existing && !ghHasBoth) {
    if (process.env.FORCE_ROTATE_B2_IAC_KEY !== "1") {
      console.error(
        `ERROR: B2 key ${IAC_KEY_NAME} (${existing.applicationKeyId}) exists but GH secrets ${GH_SECRET_KEY_ID}/${GH_SECRET_KEY} are missing. The applicationKey secret cannot be recovered. Re-run with FORCE_ROTATE_B2_IAC_KEY=1 to delete+recreate (Root only).`,
      );
      process.exit(1);
    }
    await httpJson(`${apiUrl}/b2api/v3/b2_delete_key`, b2DeleteKeySchema, {
      method: "POST",
      headers: {
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ applicationKeyId: existing.applicationKeyId }),
    });
  }

  const created = await httpJson(`${apiUrl}/b2api/v4/b2_create_key`, b2CreateKeySchema, {
    method: "POST",
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      accountId,
      keyName: IAC_KEY_NAME,
      capabilities: [...B2_IAC_PARENT_CAPABILITIES],
    }),
  });

  const applicationKeyId = created.body.applicationKeyId;
  const applicationKey = created.body.applicationKey;
  ghSecretSet(GH_SECRET_KEY_ID, applicationKeyId);
  ghSecretSet(GH_SECRET_KEY, applicationKey);

  return {
    applicationKeyId,
    created: true,
    reused: false,
  };
}

async function ensureInfisicalScopedRole(infisicalToken: string): Promise<{
  roleSlug: string;
  roleCreated: boolean;
  roleUpdated: boolean;
  membershipRoles: string[];
}> {
  const headers = {
    Authorization: `Bearer ${infisicalToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const permissions = buildOffloadSecretRolePermissions();

  const rolesResponse = await httpJson(
    `${INFISICAL_API}/v1/projects/${PROJECT_ID}/roles`,
    infisicalRolesSchema,
    { headers },
  );

  const existingRole = rolesResponse.body.roles.find((role) => role.slug === ROLE_SLUG);
  let roleCreated = false;
  let roleUpdated = false;

  if (!existingRole) {
    await httpJson(
      `${INFISICAL_API}/v1/projects/${PROJECT_ID}/roles`,
      infisicalRoleMutationSchema,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          slug: ROLE_SLUG,
          name: ROLE_NAME,
          description:
            "Create/edit/read only PULSAR_OFFLOAD_B2_* secrets in prod at / for Terraform reconcile",
          permissions,
        }),
      },
      [200, 201],
    );
    roleCreated = true;
  } else {
    await httpJson(
      `${INFISICAL_API}/v1/projects/${PROJECT_ID}/roles/${existingRole.id}`,
      infisicalRoleMutationSchema,
      {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          name: ROLE_NAME,
          description:
            "Create/edit/read only PULSAR_OFFLOAD_B2_* secrets in prod at / for Terraform reconcile",
          permissions,
        }),
      },
    );
    roleUpdated = true;
  }

  const membershipPatch = await httpJson(
    `${INFISICAL_API}/v1/projects/${PROJECT_ID}/identity-memberships/${CI_IDENTITY_ID}`,
    infisicalMembershipSchema,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        roles: [{ role: "viewer" }, { role: ROLE_SLUG }],
      }),
    },
  );

  const membershipRoles = (membershipPatch.body.identityMembership?.roles ?? []).map(
    (entry) => entry.customRoleSlug || entry.role,
  );

  return { roleSlug: ROLE_SLUG, roleCreated, roleUpdated, membershipRoles };
}

async function main(): Promise<void> {
  const managementKeyId = requireEnv("B2_MANAGEMENT_KEY_ID");
  const managementKey = requireEnv("B2_MANAGEMENT_KEY");
  const infisicalToken = getInfisicalToken();

  const b2 = await ensureB2IacParentKey(managementKeyId, managementKey);
  const infisical = await ensureInfisicalScopedRole(infisicalToken);

  const summary = {
    ok: true,
    b2IacKeyName: IAC_KEY_NAME,
    b2IacApplicationKeyId: b2.applicationKeyId,
    b2KeyCreated: b2.created,
    b2KeyReused: b2.reused,
    githubSecrets: [GH_SECRET_KEY_ID, GH_SECRET_KEY],
    infisicalProjectId: PROJECT_ID,
    infisicalCiIdentityId: CI_IDENTITY_ID,
    infisicalRoleSlug: infisical.roleSlug,
    infisicalRoleCreated: infisical.roleCreated,
    infisicalRoleUpdated: infisical.roleUpdated,
    infisicalMembershipRoles: infisical.membershipRoles,
    next: [
      "Review terraform plan for deploy/ (no apply until Root ACK)",
      "After ACK: let deploy-terraform.yml apply create bucket + broker key + PULSAR_OFFLOAD_B2_* secrets",
      "Broker stack hunks: docs/b2-pulsar-offload-broker-stack-hunks.md (separate commit after secrets exist)",
    ],
    note: "Management key was not written to GH/Infisical/stdout. Broker 5-cap key remains UNQUALIFIED for Pulsar aws-s3.",
  };

  console.log(JSON.stringify(summary, null, 2));
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  main().catch((error: unknown) => {
    console.error("ERROR: bootstrap failed", error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
