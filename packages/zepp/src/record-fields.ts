export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" ? raw.trim() : null;
}

export function getRawString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" ? raw : null;
}

export function nullable<T>(): T | null {
  return null;
}
