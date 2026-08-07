import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

function activityIdFromPath(path: string): string | undefined {
  const fileName = path.split("/").pop() ?? path;
  return fileName.match(/_(\d+)(?:_[^/]*)?\.fit$/i)?.[1];
}

export function fitExternalId(path: string, data: Buffer): string {
  const activityId = activityIdFromPath(path);
  if (activityId) return activityId;
  return `fit:${createHash("sha256").update(data).digest("hex").slice(0, 32)}`;
}

export async function fitExternalIdFromFile(path: string, filePath: string): Promise<string> {
  const activityId = activityIdFromPath(path);
  if (activityId) return activityId;

  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return `fit:${hash.digest("hex").slice(0, 32)}`;
}
