import type { ClimbingSourceLink } from "@dofek/training/climbing-context";
import { z } from "zod";

const mountainProjectSource = z.object({
  URL: z.string().optional(),
  sourceProfileId: z.string().optional(),
});
const openBetaSource = z.object({
  climb: z.object({ uuid: z.string().nullish() }).nullish(),
  climbId: z.string().nullish(),
  source: z.string().nullish(),
  user: z.object({ username: z.string().nullish() }).nullish(),
});
const kayaClimb = z.object({ slug: z.string().nullish() });
const kayaSource = kayaClimb.extend({ climb: kayaClimb.nullish() });
const uuidSchema = z.uuid();
const pathComponentSchema = z
  .string()
  .min(1)
  .regex(/^[^/\\?#%\p{Cc}\p{Cs}]+$/u)
  .refine((value) => value.trim().length > 0 && value !== "." && value !== "..");
const openBetaUsernameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/);

/** Destinations evidenced by the upstream applications; never infer tick permalinks. */
export function climbingSourceLinks(providerId: string, raw: unknown): ClimbingSourceLink[] {
  const links: ClimbingSourceLink[] = [];
  const add = (kind: ClimbingSourceLink["kind"], url: string) => {
    links.push({ providerId, kind, url });
  };
  if (providerId === "mountain-project") {
    const source = mountainProjectSource.safeParse(raw);
    if (!source.success) return links;
    const recordedUrl = source.data.URL;
    if (recordedUrl && URL.canParse(recordedUrl)) {
      const url = new URL(recordedUrl);
      if (
        url.protocol === "https:" &&
        url.hostname === "www.mountainproject.com" &&
        !url.username &&
        !url.password &&
        !url.port &&
        /^\/route\/\d+\/[^/]+$/.test(url.pathname) &&
        !url.search &&
        !url.hash
      ) {
        add("route", url.href);
      }
    }
    const profileId = source.data.sourceProfileId;
    if (profileId && /^\d+$/.test(profileId)) {
      add("ticks", `https://www.mountainproject.com/user/${profileId}/ticks/ticks`);
    }
  } else if (providerId === "openbeta") {
    const source = openBetaSource.safeParse(raw);
    if (!source.success) return links;
    const uuid =
      source.data.climb?.uuid ?? (source.data.source === "OB" ? source.data.climbId : undefined);
    if (uuidSchema.safeParse(uuid).success) add("route", `https://openbeta.io/climb/${uuid}`);
    const username = source.data.user?.username;
    if (username && openBetaUsernameSchema.safeParse(username).success) {
      add("ticks", `https://openbeta.io/u/${encodeURIComponent(username)}/ticks`);
    }
  } else if (providerId === "kaya") {
    const source = kayaSource.safeParse(raw);
    if (!source.success) return links;
    const slug = source.data.climb?.slug ?? source.data.slug;
    if (slug && pathComponentSchema.safeParse(slug).success) {
      add("route", `https://kaya-app.kayaclimb.com/climb/${encodeURIComponent(slug)}`);
    }
  }
  return links;
}
