import { createHash } from "node:crypto";

export function fingerprintOpaqueValue(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 12);
}
