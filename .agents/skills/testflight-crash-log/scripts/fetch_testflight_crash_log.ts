#!/usr/bin/env -S pnpm tsx

/**
 * Fetch TestFlight crash submissions and crash logs via App Store Connect API.
 *
 * Auth source (Infisical):
 * - APP_STORE_CONNECT_KEY_ID
 * - APP_STORE_CONNECT_ISSUER_ID
 * - APP_STORE_CONNECT_KEY_BASE64
 */

import { createPrivateKey, sign as signWithPrivateKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const API_BASE = "https://api.appstoreconnect.apple.com";

type AppStoreConnectResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  dataPoints?: Array<{ start: string; end: string; values: Record<string, number> }>;
};

type ApiResponse = {
  data?: AppStoreConnectResource[] | AppStoreConnectResource;
};

type ScriptOptions = {
  bundleId: string;
  envName: string;
  limit: number;
  buildLimit: number;
  submissionId?: string;
  logLines: number;
  saveLog?: string;
  skipBuildMetrics: boolean;
};

type Secrets = {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
};

type BuildUsage = {
  installCount: number | null;
  sessionCount: number | null;
  crashCount: number | null;
  feedbackCount: number | null;
  inviteCount: number | null;
};

function parseOptions(argv: string[]): ScriptOptions {
  const options: ScriptOptions = {
    bundleId: "com.dofek.app",
    envName: "prod",
    limit: 10,
    buildLimit: 8,
    logLines: 80,
    skipBuildMetrics: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === "--help" || token === "-h") {
      printHelp();
      process.exit(0);
    }

    if (token === "--skip-build-metrics") {
      options.skipBuildMetrics = true;
      continue;
    }

    const value = argv[index + 1];
    if (!value) {
      throw new Error(`Missing value for ${token}`);
    }

    switch (token) {
      case "--bundle-id":
        options.bundleId = value;
        index += 1;
        break;
      case "--env":
        options.envName = value;
        index += 1;
        break;
      case "--limit":
        options.limit = parseRequiredInteger(token, value);
        index += 1;
        break;
      case "--build-limit":
        options.buildLimit = parseRequiredInteger(token, value);
        index += 1;
        break;
      case "--submission-id":
        options.submissionId = value;
        index += 1;
        break;
      case "--log-lines":
        options.logLines = parseRequiredInteger(token, value);
        index += 1;
        break;
      case "--save-log":
        options.saveLog = value;
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${token}`);
    }
  }

  return options;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm tsx .agents/skills/testflight-crash-log/scripts/fetch_testflight_crash_log.ts [options]

Options:
  --bundle-id <id>          App bundle ID (default: com.dofek.app)
  --env <name>              Infisical environment (default: prod)
  --limit <n>               Max crash submissions to list (default: 10)
  --build-limit <n>         Max recent builds to inspect (default: 8)
  --submission-id <id>      Specific betaFeedbackCrashSubmission ID
  --log-lines <n>           Crash log lines to print (default: 80)
  --save-log <path>         Optional path for full crash log output
  --skip-build-metrics      Skip /metrics/betaBuildUsages calls
  -h, --help                Show this help
`);
}

function parseRequiredInteger(name: string, rawValue: string): number {
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be an integer, got: ${rawValue}`);
  }
  return parsed;
}

function infisicalGet(secretName: string, envName: string): string {
  try {
    return execFileSync(
      "infisical",
      ["secrets", "get", secretName, `--env=${envName}`, "--plain", "--silent"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    ).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read secret ${secretName}: ${message}`);
  }
}

function loadSecrets(envName: string): Secrets {
  const keyId = infisicalGet("APP_STORE_CONNECT_KEY_ID", envName);
  const issuerId = infisicalGet("APP_STORE_CONNECT_ISSUER_ID", envName);
  const keyBase64 = infisicalGet("APP_STORE_CONNECT_KEY_BASE64", envName);

  let privateKeyPem = "";
  try {
    privateKeyPem = Buffer.from(keyBase64, "base64").toString("utf8");
  } catch {
    throw new Error("APP_STORE_CONNECT_KEY_BASE64 is not valid base64");
  }

  if (!privateKeyPem.includes("BEGIN PRIVATE KEY")) {
    throw new Error("Decoded APP_STORE_CONNECT_KEY_BASE64 is not a PEM private key");
  }

  return { keyId, issuerId, privateKeyPem };
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function makeJwtToken(secrets: Secrets): string {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "ES256",
    kid: secrets.keyId,
    typ: "JWT",
  };
  const payload = {
    iss: secrets.issuerId,
    iat: now,
    exp: now + 1200,
    aud: "appstoreconnect-v1",
  };

  const headerPart = base64UrlEncode(JSON.stringify(header));
  const payloadPart = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;

  const privateKey = createPrivateKey({ key: secrets.privateKeyPem, format: "pem" });
  const signature = signWithPrivateKey("sha256", Buffer.from(signingInput, "utf8"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });

  const signaturePart = base64UrlEncode(signature);
  return `${signingInput}.${signaturePart}`;
}

async function apiGet(
  path: string,
  token: string,
  query?: Record<string, string>,
): Promise<ApiResponse> {
  const queryString = query ? `?${new URLSearchParams(query).toString()}` : "";
  const response = await fetch(`${API_BASE}${path}${queryString}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`GET ${path} failed (${response.status}): ${responseBody}`);
  }

  try {
    return JSON.parse(responseBody) as ApiResponse;
  } catch {
    throw new Error(`GET ${path} returned non-JSON response`);
  }
}

function asArray(resourceData: ApiResponse["data"]): AppStoreConnectResource[] {
  if (!resourceData) {
    return [];
  }

  return Array.isArray(resourceData) ? resourceData : [resourceData];
}

async function getApp(bundleId: string, token: string): Promise<{ appId: string; appName: string }> {
  const response = await apiGet("/v1/apps", token, {
    "filter[bundleId]": bundleId,
    "fields[apps]": "name,bundleId",
    limit: "5",
  });

  const apps = asArray(response.data);
  if (apps.length === 0) {
    throw new Error(`No App Store Connect app found for bundle id ${bundleId}`);
  }

  const app = apps[0];
  const appName = typeof app.attributes?.name === "string" ? app.attributes.name : "unknown";
  return { appId: app.id, appName };
}

async function listCrashSubmissions(
  appId: string,
  token: string,
  limit: number,
): Promise<AppStoreConnectResource[]> {
  const response = await apiGet(`/v1/apps/${appId}/betaFeedbackCrashSubmissions`, token, {
    sort: "-createdDate",
    limit: String(limit),
    "fields[betaFeedbackCrashSubmissions]":
      "createdDate,deviceModel,osVersion,buildBundleId,appPlatform",
  });

  return asArray(response.data);
}

async function listRecentBuilds(
  appId: string,
  token: string,
  limit: number,
): Promise<AppStoreConnectResource[]> {
  const response = await apiGet("/v1/builds", token, {
    "filter[app]": appId,
    sort: "-uploadedDate",
    limit: String(limit),
    "fields[builds]": "version,uploadedDate,processingState,expired",
  });

  return asArray(response.data);
}

async function readBetaBuildUsage(buildId: string, token: string): Promise<BuildUsage> {
  const response = await apiGet(`/v1/builds/${buildId}/metrics/betaBuildUsages`, token);
  const rows = asArray(response.data);

  if (rows.length === 0 || !rows[0].dataPoints || rows[0].dataPoints.length === 0) {
    return {
      installCount: null,
      sessionCount: null,
      crashCount: null,
      feedbackCount: null,
      inviteCount: null,
    };
  }

  const values = rows[0].dataPoints[0].values;
  return {
    installCount: numberOrNull(values.installCount),
    sessionCount: numberOrNull(values.sessionCount),
    crashCount: numberOrNull(values.crashCount),
    feedbackCount: numberOrNull(values.feedbackCount),
    inviteCount: numberOrNull(values.inviteCount),
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

async function readCrashLog(submissionId: string, token: string): Promise<string> {
  const response = await apiGet(`/v1/betaFeedbackCrashSubmissions/${submissionId}/crashLog`, token, {
    "fields[betaCrashLogs]": "logText",
  });

  const rows = asArray(response.data);
  if (rows.length === 0) {
    return "";
  }

  const logText = rows[0].attributes?.logText;
  return typeof logText === "string" ? logText : "";
}

function firstMatchingLine(logText: string, prefix: string): string {
  for (const line of logText.split("\n")) {
    if (line.startsWith(prefix)) {
      return line;
    }
  }
  return "";
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));

  const secrets = loadSecrets(options.envName);
  const token = makeJwtToken(secrets);

  const { appId, appName } = await getApp(options.bundleId, token);
  console.log(`App: ${appName} (${options.bundleId})`);
  console.log(`App ID: ${appId}`);

  if (!options.skipBuildMetrics) {
    const builds = await listRecentBuilds(appId, token, options.buildLimit);
    console.log(`Recent builds: ${builds.length}`);

    for (const build of builds) {
      const usage = await readBetaBuildUsage(build.id, token);
      console.log(
        "Build " +
          `version=${String(build.attributes?.version ?? "")}` +
          ` uploaded=${String(build.attributes?.uploadedDate ?? "")}` +
          ` state=${String(build.attributes?.processingState ?? "")}` +
          ` installs=${String(usage.installCount)}` +
          ` sessions=${String(usage.sessionCount)}` +
          ` crashes=${String(usage.crashCount)}` +
          ` feedback=${String(usage.feedbackCount)}`,
      );
    }

    console.log(
      "Note: beta build usage metrics are authoritative for installs/sessions/crash counts; " +
        "betaFeedbackCrashSubmissions below are feedback-linked crash reports only.",
    );
  }

  const submissions = await listCrashSubmissions(appId, token, options.limit);
  console.log(`Crash submissions: ${submissions.length}`);

  if (submissions.length === 0) {
    return;
  }

  submissions.forEach((submission, index) => {
    console.log(
      `[${index + 1}] id=${submission.id}` +
        ` created=${String(submission.attributes?.createdDate ?? "")}` +
        ` device=${String(submission.attributes?.deviceModel ?? "")}` +
        ` os=${String(submission.attributes?.osVersion ?? "")}`,
    );
  });

  const selectedSubmissionId = options.submissionId ?? submissions[0].id;
  console.log(`Selected submission: ${selectedSubmissionId}`);

  const logText = await readCrashLog(selectedSubmissionId, token);
  if (!logText) {
    console.log("No crash log text available for this submission.");
    return;
  }

  if (options.saveLog) {
    writeFileSync(options.saveLog, logText, { encoding: "utf8" });
    console.log(`Saved full crash log to: ${options.saveLog}`);
  }

  const exceptionLine = firstMatchingLine(logText, "Exception Type:");
  const terminationLine = firstMatchingLine(logText, "Termination Reason:");

  console.log("Summary:");
  if (exceptionLine) {
    console.log(exceptionLine);
  }
  if (terminationLine) {
    console.log(terminationLine);
  }

  console.log("Crash log head:");
  for (const line of logText.split("\n").slice(0, options.logLines)) {
    console.log(line);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR: ${message}`);
  process.exit(1);
});
