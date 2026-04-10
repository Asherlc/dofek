import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";
import {
  buildMergedEnvironment,
  parseInfisicalSecretsJson,
} from "./sync-dokploy-env-from-infisical-lib.ts";

const execFileAsync = promisify(execFile);

const managedKeysManifestSchema = z.object({
  apps: z.record(z.array(z.string().min(1))),
  protectedDestinationKeys: z.array(z.string().min(1)).default([]),
});

const dokployApplicationOneResponseSchema = z.object({
  result: z.object({
    data: z.object({
      json: z.object({
        env: z.string().nullable().optional(),
      }),
    }),
  }),
});

interface CliOptions {
  environment: string;
  apps: string[];
  managedKeysFile: string;
  dryRun: boolean;
  failOnMissing: boolean;
}

interface DokployClientConfig {
  host: string;
  apiKey: string;
}

interface AppExecutionConfig {
  appName: string;
  appId: string;
  managedKeys: string[];
  protectedDestinationKeys: string[];
}

function parseBooleanFlag(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected boolean value "true" or "false", received "${value}"`);
}

function parseCliOptions(argv: string[]): CliOptions {
  const defaults: CliOptions = {
    environment: "prod",
    apps: ["web", "worker"],
    managedKeysFile: "deploy/dokploy/managed-secret-keys.json",
    dryRun: false,
    failOnMissing: true,
  };

  for (const argument of argv) {
    if (argument === "--dry-run") {
      defaults.dryRun = true;
      continue;
    }

    const [flag, value] = argument.split("=", 2);
    if (!flag || value === undefined) {
      throw new Error(`Invalid argument "${argument}"`);
    }

    if (flag === "--environment") {
      defaults.environment = value;
      continue;
    }
    if (flag === "--apps") {
      defaults.apps = value
        .split(",")
        .map((appName) => appName.trim())
        .filter((appName) => appName.length > 0);
      continue;
    }
    if (flag === "--managed-keys-file") {
      defaults.managedKeysFile = value;
      continue;
    }
    if (flag === "--fail-on-missing") {
      defaults.failOnMissing = parseBooleanFlag(value);
      continue;
    }

    throw new Error(`Unknown argument "${flag}"`);
  }

  if (defaults.apps.length === 0) {
    throw new Error("At least one app must be provided via --apps");
  }

  return defaults;
}

function toDokployAppIdVariableName(appName: string): string {
  const normalizedName = appName.replace(/[^A-Za-z0-9]/g, "_").toUpperCase();
  return `DOKPLOY_${normalizedName}_APP_ID`;
}

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

async function loadInfisicalSecrets(environment: string): Promise<Map<string, string>> {
  // Use npx with a pinned version to avoid curl|bash supply-chain risk.
  // INFISICAL_TOKEN is passed via env (inherited by the child process) rather than
  // --token CLI arg, so it won't leak in error messages or /proc/cmdline.
  const { stdout } = await execFileAsync(
    "npx",
    ["@infisical/cli@0.43.72", "secrets", "--env", environment, "-o", "json", "--silent"],
    { maxBuffer: 8 * 1024 * 1024 },
  );

  return parseInfisicalSecretsJson(stdout);
}

async function fetchDokployApplicationEnvironment(
  dokployClientConfig: DokployClientConfig,
  appId: string,
): Promise<string> {
  const input = encodeURIComponent(JSON.stringify({ json: { applicationId: appId } }));
  const endpoint = `${dokployClientConfig.host}/api/trpc/application.one?input=${input}`;
  const response = await fetch(endpoint, {
    headers: {
      "x-api-key": dokployClientConfig.apiKey,
      "Content-Type": "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Dokploy application.one failed for app ${appId} with HTTP ${response.status}`);
  }

  const responsePayload: unknown = await response.json();
  const parsedPayload = dokployApplicationOneResponseSchema.parse(responsePayload);
  return parsedPayload.result.data.json.env ?? "";
}

async function updateDokployApplicationEnvironment(
  dokployClientConfig: DokployClientConfig,
  appId: string,
  envText: string,
): Promise<void> {
  const endpoint = `${dokployClientConfig.host}/api/trpc/application.update`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": dokployClientConfig.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      json: {
        applicationId: appId,
        env: envText,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Dokploy application.update failed for app ${appId} with HTTP ${response.status}`,
    );
  }
}

async function deployDokployApplication(
  dokployClientConfig: DokployClientConfig,
  appId: string,
): Promise<void> {
  const endpoint = `${dokployClientConfig.host}/api/trpc/application.deploy`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": dokployClientConfig.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      json: {
        applicationId: appId,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Dokploy application.deploy failed for app ${appId} with HTTP ${response.status}`,
    );
  }
}

async function loadManifest(
  managedKeysFile: string,
): Promise<z.infer<typeof managedKeysManifestSchema>> {
  const manifestText = await readFile(managedKeysFile, "utf8");
  const manifestJson: unknown = JSON.parse(manifestText);
  return managedKeysManifestSchema.parse(manifestJson);
}

function buildAppExecutionConfigs(
  selectedApps: string[],
  manifest: z.infer<typeof managedKeysManifestSchema>,
): AppExecutionConfig[] {
  return selectedApps.map((appName) => {
    const managedKeys = manifest.apps[appName];
    if (!managedKeys) {
      throw new Error(`App "${appName}" has no managed keys configured in manifest`);
    }

    const appIdEnvironmentVariableName = toDokployAppIdVariableName(appName);
    const appId = getRequiredEnvironmentVariable(appIdEnvironmentVariableName);

    return {
      appName,
      appId,
      managedKeys,
      protectedDestinationKeys: manifest.protectedDestinationKeys,
    };
  });
}

async function runSync(): Promise<void> {
  const cliOptions = parseCliOptions(process.argv.slice(2));
  const triggerSource = process.env.GITHUB_EVENT_NAME ?? "manual";
  const triggerIdentifier = process.env.GITHUB_RUN_ID ?? "local";
  console.log(
    `[secret-sync] start trigger=${triggerSource} run_id=${triggerIdentifier} env=${cliOptions.environment} dry_run=${String(cliOptions.dryRun)}`,
  );

  const dokployClientConfig: DokployClientConfig = {
    host: getRequiredEnvironmentVariable("DOKPLOY_HOST"),
    apiKey: getRequiredEnvironmentVariable("DOKPLOY_API_KEY"),
  };

  const manifest = await loadManifest(cliOptions.managedKeysFile);
  const appExecutionConfigs = buildAppExecutionConfigs(cliOptions.apps, manifest);
  const infisicalSecrets = await loadInfisicalSecrets(cliOptions.environment);

  const changedApps: string[] = [];

  for (const appExecutionConfig of appExecutionConfigs) {
    console.log(
      `[secret-sync] app=${appExecutionConfig.appName} app_id=${appExecutionConfig.appId} managed_keys=${appExecutionConfig.managedKeys.length}`,
    );

    const existingEnvironmentText = await fetchDokployApplicationEnvironment(
      dokployClientConfig,
      appExecutionConfig.appId,
    );
    const mergeResult = buildMergedEnvironment({
      existingEnvironmentText,
      infisicalSecrets,
      keysToSync: appExecutionConfig.managedKeys,
      failOnMissing: cliOptions.failOnMissing,
      protectedDestinationKeys: appExecutionConfig.protectedDestinationKeys,
    });

    console.log(
      `[secret-sync] app=${appExecutionConfig.appName} changed=${String(mergeResult.changed)} updated_keys=${mergeResult.updatedKeys.length} added_keys=${mergeResult.addedKeys.length} missing_keys=${mergeResult.missingKeys.length}`,
    );

    if (!mergeResult.changed) {
      continue;
    }

    changedApps.push(appExecutionConfig.appName);
    if (cliOptions.dryRun) {
      console.log(`[secret-sync] dry-run app=${appExecutionConfig.appName} apply=skipped`);
      continue;
    }

    await updateDokployApplicationEnvironment(
      dokployClientConfig,
      appExecutionConfig.appId,
      mergeResult.environmentText,
    );
    console.log(`[secret-sync] app=${appExecutionConfig.appName} env_updated=true`);

    await deployDokployApplication(dokployClientConfig, appExecutionConfig.appId);
    console.log(`[secret-sync] app=${appExecutionConfig.appName} deployed=true`);
  }

  console.log(
    `[secret-sync] complete changed_apps=${changedApps.length > 0 ? changedApps.join(",") : "none"}`,
  );
}

runSync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[secret-sync] failed: ${message}`);
  process.exitCode = 1;
});
