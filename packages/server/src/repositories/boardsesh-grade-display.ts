import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
import { gradeSortValue, isValidClimbingGrade } from "@dofek/training/climbing-grades";
import type { ClimbKind, GradeComponent } from "@dofek/training/climbing-log";
import { z } from "zod";
import { displayGradeComponents, selectRockClimbingGrade } from "./climbing-grade-display.ts";

const gradeCatalogueSchema = z.array(
  z.object({ difficultyId: z.number().int(), name: z.string().trim().min(1) }),
);
const metadataSchema = z
  .object({
    metadata: z
      .object({
        ascent: z
          .object({
            consensusDifficulty: z.number().nullable().optional(),
            consensusDifficultyName: z.string().nullable().optional(),
            boardseshDifficulty: z.number().nullable().optional(),
            boardseshConfidence: z.string().nullable().optional(),
          })
          .optional(),
        grades: gradeCatalogueSchema.optional(),
      })
      .optional(),
    difficulty: z.number().int().nullable().optional(),
  })
  .passthrough();

function componentsForLabel(label: string): GradeComponent[] {
  const parts = label.split("/").map((part) => part.trim());
  if (parts.length > 2) return [];
  const systems = ["font", "v_scale"] as const;
  return parts.flatMap((value) => {
    const system = systems.find((candidate) => isValidClimbingGrade(value, candidate));
    return system ? [{ value, system }] : [];
  });
}

function sourceDisplayGrade(
  label: string,
  catalogue: z.infer<typeof gradeCatalogueSchema>,
  kind: ClimbKind | null,
  preference: ClimbingGradePreference,
): { displayGrade: string; gradeSortValue: number } | null {
  if (kind !== "boulder" && kind !== "route") return null;
  const components = componentsForLabel(label);
  const system = preference[kind];
  const selected = components.find((component) => component.system === system);
  let sortValue = selectRockClimbingGrade(preference, kind, components)?.gradeSortValue;
  if (!selected || sortValue === undefined) return null;
  let displayGrade = selected.value;
  if (system === "font") displayGrade = displayGrade.toUpperCase();
  if (system === "v_scale") {
    const fontGrade = components.find((component) => component.system === "font")?.value;
    const mappedFonts = new Set(
      catalogue.flatMap((grade) => {
        const source = componentsForLabel(grade.name);
        return source.some(
          (component) => component.system === "v_scale" && component.value === selected.value,
        )
          ? source
              .filter((component) => component.system === "font")
              .map((component) => component.value)
          : [];
      }),
    );
    if (fontGrade?.endsWith("+") && mappedFonts.size > 1) {
      displayGrade = `${displayGrade}+`;
      sortValue = gradeSortValue(fontGrade, "font") ?? sortValue;
    }
  }
  return { displayGrade, gradeSortValue: sortValue };
}

export function boardseshGradeDisplay(
  raw: unknown,
  reportedGrades: readonly GradeComponent[],
  kind: ClimbKind | null,
  preference: ClimbingGradePreference,
): { displayGrade: string; gradeSortValue: number } | null {
  const parsed = metadataSchema.safeParse(raw);
  const catalogue = gradeCatalogueSchema.safeParse(
    parsed.success ? parsed.data.metadata?.grades : undefined,
  );
  const grades = catalogue.success ? catalogue.data : [];
  const personalId = parsed.success ? parsed.data.difficulty : undefined;
  if (reportedGrades.length && personalId !== undefined && personalId !== null) {
    const personalLabel = grades.find((grade) => grade.difficultyId === personalId)?.name;
    const personal = personalLabel
      ? sourceDisplayGrade(personalLabel, grades, kind, preference)
      : null;
    if (personal) return personal;
  }
  if (reportedGrades.length) {
    const displayed = displayGradeComponents(preference, kind, reportedGrades);
    const selected = selectRockClimbingGrade(preference, kind, reportedGrades);
    if (displayed && selected)
      return { displayGrade: displayed, gradeSortValue: selected.gradeSortValue };
  }

  if (!parsed.success) return null;
  const ascent = parsed.data.metadata?.ascent;
  if (!ascent) return null;
  const estimateTiers = new Set([
    "setter_only",
    "cross_angle_estimate",
    "moonboard_angle_estimate",
    "moonboard_wide_angle_estimate",
  ]);
  const modelDifficulty = ascent.boardseshDifficulty;
  const trustedModelGrade =
    modelDifficulty != null && !estimateTiers.has(ascent.boardseshConfidence ?? "");
  const difficultyId = trustedModelGrade ? Math.round(modelDifficulty) : ascent.consensusDifficulty;
  if (difficultyId === null || difficultyId === undefined) return null;
  const sourceGrade = grades.find((grade) => grade.difficultyId === difficultyId)?.name;
  const label =
    sourceGrade ?? (!trustedModelGrade ? (ascent.consensusDifficultyName ?? undefined) : undefined);
  return label ? sourceDisplayGrade(label, grades, kind, preference) : null;
}
