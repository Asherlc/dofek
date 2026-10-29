import type { ClimbingTag } from "@dofek/training/climbing-tags";
import { decodeKayaClimbingTags } from "./providers/kaya/climbing-tags.ts";

export function recordedClimbingTags(providerId: string, raw: unknown): ClimbingTag[] {
  return providerId === "kaya" ? decodeKayaClimbingTags(raw) : [];
}
