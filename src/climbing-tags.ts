import { decodeKayaClimbingTags } from "@dofek/climbing-catalogue/kaya-tags";
import type { ClimbingTag } from "@dofek/training/climbing-tags";

export function recordedClimbingTags(providerId: string, raw: unknown): ClimbingTag[] {
  return providerId === "kaya" ? decodeKayaClimbingTags(raw) : [];
}
