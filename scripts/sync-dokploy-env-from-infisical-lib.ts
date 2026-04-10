import { z } from "zod";

const infisicalSecretSchema = z.object({
  secretKey: z.string().min(1),
  secretValue: z.string(),
});

const infisicalSecretListSchema = z.array(infisicalSecretSchema);

const environmentAssignmentPattern = /^([A-Z0-9_]+)=(.*)$/;

/** Quote a value for KEY=value format if it contains newlines or carriage returns. */
function formatEnvValue(key: string, value: string): string {
  if (value.includes("\n") || value.includes("\r")) {
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `${key}="${escaped}"`;
  }
  return `${key}=${value}`;
}

interface EnvironmentLine {
  line: string;
  key: string | null;
  value: string | null;
}

interface ParsedEnvironment {
  hadTrailingNewline: boolean;
  lines: EnvironmentLine[];
  keyIndexByName: Map<string, number[]>;
}

export interface BuildMergedEnvironmentOptions {
  existingEnvironmentText: string;
  infisicalSecrets: Map<string, string>;
  keysToSync: string[];
  failOnMissing?: boolean;
  protectedDestinationKeys?: string[];
}

export interface BuildMergedEnvironmentResult {
  environmentText: string;
  changed: boolean;
  updatedKeys: string[];
  addedKeys: string[];
  missingKeys: string[];
}

function parseEnvironment(existingEnvironmentText: string): ParsedEnvironment {
  const hadTrailingNewline = existingEnvironmentText.endsWith("\n");
  const normalizedText = hadTrailingNewline
    ? existingEnvironmentText.slice(0, Math.max(0, existingEnvironmentText.length - 1))
    : existingEnvironmentText;

  const rawLines = normalizedText.length === 0 ? [] : normalizedText.split("\n");

  const lines: EnvironmentLine[] = [];
  const keyIndexByName = new Map<string, number[]>();

  rawLines.forEach((line, lineIndex) => {
    const assignmentMatch = environmentAssignmentPattern.exec(line);
    if (!assignmentMatch) {
      lines.push({ line, key: null, value: null });
      return;
    }

    const key = assignmentMatch[1] ?? null;
    const value = assignmentMatch[2] ?? null;
    lines.push({ line, key, value });

    if (key) {
      const indexes = keyIndexByName.get(key);
      if (!indexes) {
        keyIndexByName.set(key, [lineIndex]);
      } else {
        indexes.push(lineIndex);
      }
    }
  });

  return { hadTrailingNewline, lines, keyIndexByName };
}

function isProtectedKey(key: string, protectedDestinationKeys: string[]): boolean {
  return protectedDestinationKeys.some((protectedPattern) => {
    if (protectedPattern.endsWith("*")) {
      const protectedPrefix = protectedPattern.slice(0, Math.max(0, protectedPattern.length - 1));
      return key.startsWith(protectedPrefix);
    }
    return key === protectedPattern;
  });
}

function serializeEnvironment(parsedEnvironment: ParsedEnvironment): string {
  const serialized = parsedEnvironment.lines.map((line) => line.line).join("\n");
  if (serialized.length === 0) {
    return "";
  }
  if (parsedEnvironment.hadTrailingNewline) {
    return `${serialized}\n`;
  }
  return serialized;
}

export function parseInfisicalSecretsJson(infisicalSecretsJson: string): Map<string, string> {
  const parsedJson: unknown = JSON.parse(infisicalSecretsJson);
  const parsedSecrets = infisicalSecretListSchema.parse(parsedJson);
  return new Map(parsedSecrets.map((secret) => [secret.secretKey, secret.secretValue]));
}

export function buildMergedEnvironment(
  options: BuildMergedEnvironmentOptions,
): BuildMergedEnvironmentResult {
  const failOnMissing = options.failOnMissing ?? true;
  const protectedDestinationKeys = options.protectedDestinationKeys ?? [];
  const parsedEnvironment = parseEnvironment(options.existingEnvironmentText);
  const updatedKeys: string[] = [];
  const addedKeys: string[] = [];
  const missingKeys: string[] = [];

  for (const managedKey of options.keysToSync) {
    if (isProtectedKey(managedKey, protectedDestinationKeys)) {
      throw new Error(`Refusing to manage protected destination key "${managedKey}"`);
    }
  }

  for (const managedKey of options.keysToSync) {
    const infisicalValue = options.infisicalSecrets.get(managedKey);
    if (infisicalValue === undefined) {
      missingKeys.push(managedKey);
      continue;
    }

    const existingIndexes = parsedEnvironment.keyIndexByName.get(managedKey) ?? [];
    if (existingIndexes.length > 1) {
      throw new Error(`Managed key "${managedKey}" appears multiple times in destination env`);
    }

    const existingIndex = existingIndexes[0];
    if (existingIndex === undefined) {
      parsedEnvironment.lines.push({
        line: formatEnvValue(managedKey, infisicalValue),
        key: managedKey,
        value: infisicalValue,
      });
      addedKeys.push(managedKey);
      continue;
    }

    const existingLine = parsedEnvironment.lines[existingIndex];
    if (!existingLine || existingLine.value === null) {
      throw new Error(`Expected parsable assignment line for managed key "${managedKey}"`);
    }

    if (existingLine.value !== infisicalValue) {
      existingLine.line = formatEnvValue(managedKey, infisicalValue);
      existingLine.value = infisicalValue;
      updatedKeys.push(managedKey);
    }
  }

  if (missingKeys.length > 0 && failOnMissing) {
    throw new Error(`Missing managed keys in Infisical: ${missingKeys.join(", ")}`);
  }

  const changed = updatedKeys.length > 0 || addedKeys.length > 0;
  return {
    environmentText: serializeEnvironment(parsedEnvironment),
    changed,
    updatedKeys,
    addedKeys,
    missingKeys,
  };
}
