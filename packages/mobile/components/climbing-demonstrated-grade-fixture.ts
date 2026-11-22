import {
  climbingDemonstratedGradeSchema,
  type DemonstratedGrade,
  type DemonstratedGradeSend,
} from "@dofek/training/climbing-demonstrated-grade";

function send(
  overrides: Partial<DemonstratedGradeSend> &
    Pick<DemonstratedGradeSend, "displayName" | "climbedOn">,
): DemonstratedGradeSend {
  return {
    provider: "KAYA",
    providerId: "climb-kaya",
    ropeMethod: null,
    ascentStyle: "Flash",
    logEntryId: "log-1",
    activityId: "activity-1",
    climbExternalId: "climb-1",
    sourceUrl: "https://example.test/climb-1",
    ...overrides,
  };
}

function grade(
  value: string,
  sends: DemonstratedGradeSend[],
  overrides: Partial<DemonstratedGrade> = {},
): DemonstratedGrade {
  return {
    grade: value,
    gradeSystem: value.startsWith("V") ? "v_scale" : "french",
    gradeSortValue: value.startsWith("V") ? 50 : 55,
    count: 3,
    publishedLabel: null,
    sends,
    ...overrides,
  };
}

export const demonstratedGradeFixture = climbingDemonstratedGradeSchema.parse({
  startDate: "2026-08-22",
  endDate: "2026-11-21",
  coverage: { fullWindow: true, startDate: "2026-08-22", endDate: "2026-11-21" },
  method: "Dofek adaptation of IRCRA 3:3:3",
  minimumDistinctClimbs: 3,
  cells: [
    {
      type: "bouldering",
      setting: "indoor",
      grades: [
        grade("V5", [
          send({ displayName: "Green Overhang", climbedOn: "2026-11-12", ascentStyle: "Flash" }),
          send({
            displayName: "Corner Traverse",
            climbedOn: "2026-10-24",
            ascentStyle: "Redpoint",
          }),
          send({ displayName: "Blue Arete", climbedOn: "2026-09-18", ascentStyle: null }),
        ]),
      ],
    },
    {
      type: "bouldering",
      setting: "outdoor",
      grades: [
        grade("V4", [
          send({
            displayName: "Cedar Slab",
            climbedOn: "2026-11-09",
            provider: "Mountain Project",
            sourceUrl: "https://example.test/cedar-slab",
          }),
          send({
            displayName: "The Pocket Problem",
            climbedOn: "2026-10-18",
            provider: "Mountain Project",
            sourceUrl: "https://example.test/pocket-problem",
          }),
          send({
            displayName: "Granite Rail",
            climbedOn: "2026-09-27",
            provider: "Mountain Project",
            sourceUrl: "https://example.test/granite-rail",
          }),
        ]),
      ],
    },
    { type: "lead", setting: "indoor", grades: [] },
    {
      type: "lead",
      setting: "outdoor",
      grades: [
        grade("5.11a", [
          send({
            displayName: "Pine Needle",
            climbedOn: "2026-11-08",
            provider: "Mountain Project",
            sourceUrl: "https://example.test/pine-needle",
          }),
          send({
            displayName: "The Left Edge",
            climbedOn: "2026-10-17",
            provider: "Mountain Project",
            ascentStyle: "Onsight",
            sourceUrl: "https://example.test/left-edge",
          }),
          send({
            displayName: "Sunlit Corner",
            climbedOn: "2026-09-06",
            provider: "Mountain Project",
            sourceUrl: "https://example.test/sunlit-corner",
          }),
        ]),
      ],
    },
    { type: "top_rope", setting: "indoor", grades: [] },
    { type: "top_rope", setting: "outdoor", grades: [] },
    { type: "unroped", setting: "indoor", grades: [] },
    { type: "unroped", setting: "outdoor", grades: [] },
  ],
});
