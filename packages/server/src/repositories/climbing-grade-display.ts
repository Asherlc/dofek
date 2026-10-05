import {
  type ClimbingClimbType,
  type ClimbingGradePreference,
  type ClimbingGradeSystem,
  convertClimbingGrade,
  gradeSortValue,
  isGradeSystemForClimbType,
} from "@dofek/training/climbing-grades";

interface DisplayGrade {
  grade: string;
  gradeSortValue: number;
  gradeSystem: ClimbingGradeSystem;
}

export function displayClimbingGrade(
  gradePreference: ClimbingGradePreference,
  climbType: ClimbingClimbType,
  sourceSystem: ClimbingGradeSystem,
  sourceGrade: string,
): DisplayGrade | null {
  if (!isGradeSystemForClimbType(sourceSystem, climbType)) return null;
  const displaySystem = gradePreference[climbType];
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
