import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { getNewPasswordValidationError } from "@dofek/auth/auth";

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export class InvalidPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPasswordError";
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validatePassword(password: string): void {
  const validationError = getNewPasswordValidationError(password);
  if (validationError) {
    throw new InvalidPasswordError(validationError);
  }
}

export function hashPassword(password: string): string {
  validatePassword(password);
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  }).toString("hex");
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return false;
  }

  const [, nRaw, rRaw, pRaw, salt, expectedHashHex] = parts;
  if (!nRaw || !rRaw || !pRaw || !salt || !expectedHashHex) {
    return false;
  }

  const cost = Number(nRaw);
  const blockSize = Number(rRaw);
  const parallelization = Number(pRaw);
  if (!Number.isFinite(cost) || !Number.isFinite(blockSize) || !Number.isFinite(parallelization)) {
    return false;
  }

  const derived = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: cost,
    r: blockSize,
    p: parallelization,
  });
  const expected = Buffer.from(expectedHashHex, "hex");
  if (derived.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(derived, expected);
}
