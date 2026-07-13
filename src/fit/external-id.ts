import { createHash } from "node:crypto";

export function fitExternalId(path: string, data: Buffer): string {
  const fileName = path.split("/").pop() ?? path;
  const match = fileName.match(/_(\d+)(?:_[^/]*)?\.fit$/i);
  if (match?.[1]) return match[1];
  return `fit:${createHash("sha256").update(data).digest("hex").slice(0, 32)}`;
}
