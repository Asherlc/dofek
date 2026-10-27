import { readFileSync } from "node:fs";

const APPLE_PRIVATE_KEY_SECRET_PATH = "/run/secrets/apple_private_key";

export function getApplePrivateKey(): string {
  try {
    const secret = readFileSync(APPLE_PRIVATE_KEY_SECRET_PATH, "utf8");
    if (secret.trim().length > 0) return secret;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw new Error("Unable to read the Apple private key Swarm secret", { cause: error });
    }
  }

  const environmentValue = process.env.APPLE_PRIVATE_KEY;
  if (!environmentValue) {
    throw new Error("APPLE_PRIVATE_KEY is required");
  }
  return environmentValue;
}

export function hasApplePrivateKey(): boolean {
  try {
    return readFileSync(APPLE_PRIVATE_KEY_SECRET_PATH, "utf8").trim().length > 0;
  } catch (error: unknown) {
    if (!isMissingFileError(error)) {
      throw new Error("Unable to read the Apple private key Swarm secret", { cause: error });
    }
  }
  return Boolean(process.env.APPLE_PRIVATE_KEY);
}

function isMissingFileError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
