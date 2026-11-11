import type { ClimbingLogEntry } from "./climbing-log.ts";
import type { ClimbingTag } from "./climbing-tags.ts";

type TagGroup = {
  key: string;
  providerId: string;
  categoryLabel: string;
  tags: ClimbingTag[];
};

/** Keep source categories intact while omitting grip labels already rendered as hold types. */
export function climbingTagGroups(
  tags: readonly ClimbingTag[],
  holdTypes: ClimbingLogEntry["holdTypes"],
): TagGroup[] {
  const groups = new Map<string, TagGroup>();
  const seen = new Set<string>();
  const displayedHolds = new Set(holdTypes?.map((hold) => hold.replaceAll("_", " ")) ?? []);
  for (const tag of tags) {
    if (
      tag.categoryLabel?.toLowerCase() === "grip" &&
      displayedHolds.has(tag.label.trim().toLowerCase().replaceAll("_", " "))
    )
      continue;
    const key = JSON.stringify([tag.providerId, tag.categoryKey]);
    const tagKey = JSON.stringify([key, tag.sourceKey]);
    if (seen.has(tagKey)) continue;
    seen.add(tagKey);
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        providerId: tag.providerId,
        categoryLabel: tag.categoryLabel ?? tag.categoryKey ?? "Uncategorized tags",
        tags: [],
      };
      groups.set(key, group);
    }
    group.tags.push(tag);
  }
  return [...groups.values()];
}
