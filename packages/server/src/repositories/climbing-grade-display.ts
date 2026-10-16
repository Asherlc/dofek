import {
  type ClimbingGradePreference,
  convertClimbingGrade,
  type FreeRockGradeSystem,
  type GradeSystem,
  gradeSortValue,
  isGradeSystemForClimbKind,
} from "@dofek/training/climbing-grades";
import type { ClimbKind, GradeComponent } from "@dofek/training/climbing-log";

interface DisplayGrade {
  grade: string;
  gradeSortValue: number;
  gradeSystem: FreeRockGradeSystem;
}

export function displayClimbingGrade(
  gradePreference: ClimbingGradePreference,
  climbKind: ClimbKind,
  sourceSystem: GradeSystem,
  sourceGrade: string,
): DisplayGrade | null {
  if (climbKind === "summit" || !isGradeSystemForClimbKind(sourceSystem, climbKind)) return null;
  const displaySystem = gradePreference[climbKind];
  const converted = convertClimbingGrade({
    grade: sourceGrade,
    sourceSystem,
    displaySystem,
  });
  if (converted) {
    return {
      grade: converted.displayGrade,
      gradeSystem: converted.displaySystem,
      gradeSortValue: converted.sortValue,
    };
  }
  const sourceSortValue = gradeSortValue(sourceGrade, sourceSystem);
  return sourceSortValue === null
    ? null
    : { grade: sourceGrade, gradeSystem: sourceSystem, gradeSortValue: sourceSortValue };
}

export function displayGradeComponents(
  gradePreference: ClimbingGradePreference,
  kind: ClimbKind | null,
  grades: readonly GradeComponent[],
): string | null {
  if (!grades.length) return null;
  if (kind !== "boulder" && kind !== "route") return grades.map((grade) => grade.value).join(" ");
  const compatible = grades.filter(
    (grade) => grade.system !== null && isGradeSystemForClimbKind(grade.system, kind),
  );
  const selected =
    compatible.find((grade) => grade.system === gradePreference[kind]) ?? compatible[0];
  return (
    grades
      .flatMap((grade) => {
        if (grade.system === null || !isGradeSystemForClimbKind(grade.system, kind))
          return [grade.value];
        return grade === selected
          ? [
              displayClimbingGrade(gradePreference, kind, grade.system, grade.value)?.grade ??
                grade.value,
            ]
          : [];
      })
      .join(" ") || null
  );
}

export function selectRockClimbingGrade(
  preference: ClimbingGradePreference,
  kind: ClimbKind | null,
  grades: readonly GradeComponent[],
): DisplayGrade | null {
  if (kind !== "boulder" && kind !== "route") return null;
  const compatible = grades.filter(
    (grade) => grade.system !== null && isGradeSystemForClimbKind(grade.system, kind),
  );
  const selected = compatible.find((grade) => grade.system === preference[kind]) ?? compatible[0];
  return selected?.system === undefined || selected.system === null
    ? null
    : displayClimbingGrade(preference, kind, selected.system, selected.value);
}
