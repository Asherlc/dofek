import { z } from "zod";

const MAX_ACCOUNT_ERASURE_RETENTION_DAYS = 29;

const configSchema = z.object({
  axiomApiToken: z.string().min(1),
  axiomDataset: z.string().min(1),
  axiomOrgId: z.string().min(1).optional(),
  sentryApiHost: z.url(),
  sentryAuthToken: z.string().min(1),
  sentryOrg: z.string().min(1),
});
const axiomDatasetSchema = z.object({
  retentionDays: z.number().int().positive(),
  useRetentionPeriod: z.boolean(),
});
const sentryOrganizationSchema = z.object({
  dataRetention: z.number().int().positive(),
});

export type ProcessorRetentionConfig = z.infer<typeof configSchema>;

function requiredEnvironmentValue(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`${name} is required for account erasure`);
  }
  return value.trim();
}

export function processorRetentionConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProcessorRetentionConfig {
  return configSchema.parse({
    axiomApiToken: requiredEnvironmentValue(env, "AXIOM_API_TOKEN"),
    axiomDataset: env.AXIOM_LOG_DATASET?.trim() || "dofek-logs",
    ...(env.AXIOM_ORG_ID?.trim() ? { axiomOrgId: env.AXIOM_ORG_ID.trim() } : {}),
    sentryApiHost: env.SENTRY_API_HOST?.trim() || "https://us.sentry.io",
    sentryAuthToken: requiredEnvironmentValue(env, "SENTRY_AUTH_TOKEN"),
    sentryOrg: requiredEnvironmentValue(env, "SENTRY_ORG"),
  });
}

async function loadAxiomRetentionDays(
  config: ProcessorRetentionConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<number> {
  const response = await fetchFn(
    `https://api.axiom.co/v2/datasets/${encodeURIComponent(config.axiomDataset)}`,
    {
      headers: {
        Authorization: `Bearer ${config.axiomApiToken}`,
        ...(config.axiomOrgId ? { "X-Axiom-Org-Id": config.axiomOrgId } : {}),
      },
    },
  );
  if (!response.ok) {
    throw new Error(`Axiom dataset retention verification failed with status ${response.status}`);
  }
  const dataset = axiomDatasetSchema.parse(await response.json());
  if (!dataset.useRetentionPeriod) {
    throw new Error("Axiom dataset retention is not enabled");
  }
  if (dataset.retentionDays > MAX_ACCOUNT_ERASURE_RETENTION_DAYS) {
    throw new Error("Axiom dataset retention exceeds the 29-day account-erasure boundary");
  }
  return dataset.retentionDays;
}

async function loadSentryRetentionDays(
  config: ProcessorRetentionConfig,
  fetchFn: typeof globalThis.fetch,
): Promise<number> {
  const url = new URL(
    `/api/0/organizations/${encodeURIComponent(config.sentryOrg)}/`,
    new URL(config.sentryApiHost).origin,
  );
  url.searchParams.set("detailed", "1");
  const response = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${config.sentryAuthToken}`,
    },
  });
  if (response.status === 403) {
    throw new Error("Sentry organization retention verification requires org:read access");
  }
  if (!response.ok) {
    throw new Error(
      `Sentry organization retention verification failed with status ${response.status}`,
    );
  }
  const organization = sentryOrganizationSchema.safeParse(await response.json());
  if (!organization.success) {
    throw new Error(
      "Sentry organization response does not expose dataRetention; account erasure cannot verify the retention boundary",
    );
  }
  if (organization.data.dataRetention > MAX_ACCOUNT_ERASURE_RETENTION_DAYS) {
    throw new Error("Sentry event retention exceeds the 29-day account-erasure boundary");
  }
  return organization.data.dataRetention;
}

export async function verifyProcessorRetentionPolicies(
  rawConfig: ProcessorRetentionConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<{
  axiomRetentionDays: number;
  sentryRetentionDays: number;
}> {
  const config = configSchema.parse(rawConfig);
  const axiomRetentionDays = await loadAxiomRetentionDays(config, fetchFn);
  const sentryRetentionDays = await loadSentryRetentionDays(config, fetchFn);
  return { axiomRetentionDays, sentryRetentionDays };
}
