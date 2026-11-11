import { expect, it } from "vitest";
import { climbingTagGroups } from "./climbing-tag-presentation.ts";

it("preserves source/category identities and hides only a displayed known grip", () => {
  const tags = [
    {
      providerId: "kaya",
      sourceKey: "1",
      label: "No Grips",
      categoryKey: "3",
      categoryLabel: "Grip",
    },
    {
      providerId: "kaya",
      sourceKey: "2",
      label: "Unknown grip",
      categoryKey: "3",
      categoryLabel: "Grip",
    },
    {
      providerId: "kaya",
      sourceKey: "3",
      label: "No Grips",
      categoryKey: "custom",
      categoryLabel: "Custom",
    },
    {
      providerId: "other",
      sourceKey: "2",
      label: "Uncategorized",
      categoryKey: null,
      categoryLabel: null,
    },
    {
      providerId: "other",
      sourceKey: "4",
      label: "Numeric category",
      categoryKey: "42",
      categoryLabel: null,
    },
  ];
  const result = climbingTagGroups([...tags, ...tags.slice(1, 2)], ["no_grips"]);
  expect(
    result.map((group) => [
      group.providerId,
      group.categoryLabel,
      group.tags.map((tag) => tag.label),
    ]),
  ).toEqual([
    ["kaya", "Grip", ["Unknown grip"]],
    ["kaya", "Custom", ["No Grips"]],
    ["other", "Uncategorized tags", ["Uncategorized"]],
    ["other", "42", ["Numeric category"]],
  ]);
});
