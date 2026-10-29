import { describe, expect, it } from "vitest";
import { recordedClimbingTags } from "./climbing-tags.ts";

describe("recordedClimbingTags", () => {
  const tags = [
    { id: "937", name: "Crimp", tag_type_id: "3" },
    { id: 42, name: "My custom style", tag_type_id: 81 },
    { id: "43", name: "Uncategorized", tag_type_id: null },
  ];
  const expected = [
    {
      providerId: "kaya",
      sourceKey: "937",
      label: "Crimp",
      categoryKey: "3",
      categoryLabel: "Grip",
    },
    {
      providerId: "kaya",
      sourceKey: "42",
      label: "My custom style",
      categoryKey: "81",
      categoryLabel: null,
    },
    {
      providerId: "kaya",
      sourceKey: "43",
      label: "Uncategorized",
      categoryKey: null,
      categoryLabel: null,
    },
  ];
  it.each([false, true])("decodes literal source tags from nested ascent shape: %s", (ascent) => {
    const raw = ascent ? { climb: { tags } } : { tags };
    expect(recordedClimbingTags("kaya", raw)).toEqual(expected);
  });
  it.each([
    { tags, climb: "invalid" },
    { tags: "invalid", climb: { tags } },
  ])("retains valid tags when an unused source path is malformed: %j", (raw) => {
    expect(recordedClimbingTags("kaya", raw)).toEqual(expected);
  });
  it("prefers nested ascent tags when both tag paths are valid", () => {
    expect(recordedClimbingTags("kaya", { tags: [tags[1]], climb: { tags: [tags[0]] } })).toEqual([
      expected[0],
    ]);
    expect(recordedClimbingTags("kaya", { tags, climb: { tags: [] } })).toEqual([]);
  });
  it("deduplicates source identities without collapsing categories or labels", () => {
    expect(
      recordedClimbingTags("kaya", {
        tags: [
          tags[0],
          tags[0],
          { id: "937", name: "Crimp", tag_type_id: "81" },
          { id: "938", name: "Crimp", tag_type_id: "3" },
        ],
      }),
    ).toHaveLength(3);
  });
  it.each([
    "Custom",
    "Movement",
    "Grip",
    "Footwork",
    "General",
    "Style",
    "Conditions",
    "Start",
    "Finish",
    "Boldness",
  ])("retains the documented category %s", (label) => {
    const categories = [
      "Custom",
      "Movement",
      "Grip",
      "Footwork",
      "General",
      "Style",
      "Conditions",
      "Start",
      "Finish",
      "Boldness",
    ];
    expect(
      recordedClimbingTags("kaya", {
        tags: [{ id: "custom", name: "A tag", tag_type_id: categories.indexOf(label) + 1 }],
      })[0]?.categoryLabel,
    ).toBe(label);
  });
  it("preserves literal unfamiliar labels", () => {
    expect(
      recordedClimbingTags("kaya", { tags: [{ id: "custom", name: "  Fancy STYLE!  " }] }),
    ).toEqual([
      {
        providerId: "kaya",
        sourceKey: "custom",
        label: "  Fancy STYLE!  ",
        categoryKey: null,
        categoryLabel: null,
      },
    ]);
  });
  it.each([null, undefined, {}, { tags: null }, { climb: null }, { tags: "invalid" }])(
    "keeps missing tags unknown: %j",
    (raw) => {
      expect(recordedClimbingTags("kaya", raw)).toEqual([]);
    },
  );
  it("ignores malformed tags individually without losing valid retained tags", () => {
    expect(
      recordedClimbingTags("kaya", {
        tags: [null, {}, { id: "x", name: "" }, { id: "   ", name: "No identity" }, tags[0]],
      }),
    ).toEqual([expected[0]]);
  });
  it("preserves unfamiliar category IDs that match object property names", () => {
    expect(
      recordedClimbingTags("kaya", {
        tags: [{ id: "custom", name: "Funky", tag_type_id: "constructor" }],
      }),
    ).toEqual([
      {
        providerId: "kaya",
        sourceKey: "custom",
        label: "Funky",
        categoryKey: "constructor",
        categoryLabel: null,
      },
    ]);
  });
  it("does not interpret another provider's payload as KAYA", () => {
    expect(recordedClimbingTags("openbeta", { tags })).toEqual([]);
  });
});
