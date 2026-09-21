import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORBIDDEN_CANONICAL_FIELD_NAMES = [
  "activeEnergyKcal",
  "basalEnergyKcal",
  "recoveryHighMinutes",
  "resilienceLevel",
  "sleepNeedBaselineMinutes",
  "sleepNeedFromDebtMinutes",
  "sleepNeedFromStrainMinutes",
  "sleepNeedFromNapMinutes",
  "stressHighMinutes",
] as const;

const FORBIDDEN_CANONICAL_COLUMN_NAMES = [
  "recovery_high_minutes",
  "resilience_level",
  "sleep_need_baseline_minutes",
  "sleep_need_from_debt_minutes",
  "sleep_need_from_strain_minutes",
  "sleep_need_from_nap_minutes",
  "stress_high_minutes",
] as const;

const FORBIDDEN_HEALTH_EVENT_TYPES = [
  "oura_daily_stress",
  "oura_daily_resilience",
  "oura_cardiovascular_age",
  "oura_sleep_time",
] as const;

const canonicalFieldPattern = new RegExp(
  `(?:^|[,{])\\s*(?:[A-Za-z_$][\\w$]*\\.)?(${FORBIDDEN_CANONICAL_FIELD_NAMES.join("|")})\\s*:`,
);
const canonicalAssignmentPattern = new RegExp(
  `(?:^|\\s)(?:[A-Za-z_$][\\w$]*\\.)?(${FORBIDDEN_CANONICAL_FIELD_NAMES.join("|")})\\s*=`,
);
const canonicalColumnPattern = new RegExp(
  `\\b(?:${FORBIDDEN_CANONICAL_COLUMN_NAMES.join("|")})\\b`,
);
const stressChannelPattern = /\bstress\s*:\s*(?:sample|value|metrics)\./;
const healthEventPattern = new RegExp(
  `(?:type|eventType)\\s*:\\s*["'](${FORBIDDEN_HEALTH_EVENT_TYPES.join("|")})["']`,
);
const thresholdObservationPattern =
  /recordProviderThresholdObservation|providerThresholdObservation|thresholdType\s*:/;

export function findProviderDerivedMetricViolations(source: string, fileName: string): string[] {
  const violations: string[] = [];

  for (const [index, line] of source.split("\n").entries()) {
    const lineNumber = index + 1;
    const add = (message: string) => violations.push(`${fileName}:${lineNumber}: ${message}`);

    const fieldMatch = line.match(canonicalFieldPattern) ?? line.match(canonicalAssignmentPattern);
    if (fieldMatch) {
      add(`canonical provider-derived field ${fieldMatch[1]}`);
    }
    if (canonicalColumnPattern.test(line)) {
      add("canonical provider-derived column");
    }
    if (stressChannelPattern.test(line)) {
      add("canonical provider-derived stress channel");
    }
    if (healthEventPattern.test(line)) {
      add("canonical provider-derived health event");
    }
    if (thresholdObservationPattern.test(line)) {
      add("canonical provider threshold observation");
    }
  }

  return violations;
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...sourceFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts") && !path.endsWith(".test.ts")) {
      files.push(path);
    }
  }
  return files;
}

export function scanRepository(repoRoot: string): string[] {
  const roots = ["src/providers", "packages/server/src/routes", "packages/server/src/mcp"].map(
    (path) => resolve(repoRoot, path),
  );
  return roots.flatMap((root) =>
    sourceFiles(root).flatMap((file) =>
      findProviderDerivedMetricViolations(readFileSync(file, "utf8"), relative(repoRoot, file)),
    ),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const violations = scanRepository(repoRoot);
  if (violations.length > 0) {
    console.error("Provider-derived canonical writes detected:");
    for (const violation of violations) console.error(`- ${violation}`);
    process.exitCode = 1;
  } else {
    console.log("Provider-derived metric policy: no forbidden canonical writes found.");
  }
}
