import { z } from "zod";

export const imageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const deployImageSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9./:_-]*(?:@sha256:[a-f0-9]{64})?$/);

export function imageRepository(image: string): string {
  return image.split("@")[0]?.replace(/:[^/:]+$/, "") ?? "";
}

/** Swarm may retain an optional tag alongside the immutable manifest digest. */
export function immutableImageReference(image: string): string {
  deployImageSchema.parse(image);
  const parts = image.split("@");
  if (parts.length !== 2) throw new Error(`Image must include an immutable digest: ${image}`);
  return `${imageRepository(image)}@${imageDigestSchema.parse(parts[1])}`;
}
