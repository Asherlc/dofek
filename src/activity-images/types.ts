import { createHash } from "node:crypto";

export interface ImageVariant {
  url: string;
  width: number | null;
  height: number | null;
}
export interface ProviderImageCandidate {
  sourceId: string;
  kind: "photo" | "screenshot" | "class_artwork";
  caption: string | null;
  position: number;
  variants: ImageVariant[];
  revision: string | null;
  raw: Record<string, unknown>;
}
export interface ImageDiscovery {
  retryable?: boolean;
  retryAfterSeconds?: number;
  coverage: "complete" | "partial" | "unavailable" | "failed";
  expectedCount: number | null;
  reason: string | null;
  images: ProviderImageCandidate[];
}
interface ImageWork {
  id: string;
  userId: string;
  providerId: string;
  activityExternalId: string;
  imageId: string;
  generation: number;
  candidate: ProviderImageCandidate;
  attempts: number;
}
export type ActivityImageWork = ImageWork &
  (
    | { activityId: string; climbingLogEntryId?: never }
    | { activityId: null; climbingLogEntryId: string }
  );
export function selectImageVariant(variants: ImageVariant[]): ImageVariant {
  const sorted = [...variants].sort(
    (a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0),
  );
  const best = sorted[0];
  if (!best) throw new Error("No image variants");
  return best;
}
/** Fallback only: adapters should use the provider's stable media ID. */
export function sourceImageIdentity(url: string): string {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (
      /^(x-amz-|x-goog-)/i.test(key) ||
      /^(signature|expires|token|policy|key-pair-id)$/i.test(key)
    ) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();
  return createHash("sha256")
    .update(`${parsed.origin}${parsed.pathname}${parsed.search}`)
    .digest("hex");
}
