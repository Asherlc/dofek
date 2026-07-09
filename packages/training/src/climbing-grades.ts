export type ClimbingGradeSystem = "v_scale" | "yds";

export interface ParsedClimbingGrade {
  gradeSystem: ClimbingGradeSystem;
  grade: string;
  sortValue: number;
}

const vScalePattern = /^V(?<grade>B|0|[1-9]\d*)$/i;
const yosemiteDecimalSystemPattern = /^5\.(?<majorGrade>\d{1,2})(?<modifier>[ABCD]|[+-])?$/i;

const yosemiteLetterSortOffsets = new Map<string, number>([
  ["a", 1],
  ["b", 2],
  ["c", 3],
  ["d", 4],
]);

class ClimbingGradeParser {
  parse(input: string): ParsedClimbingGrade | null {
    const trimmedInput = input.trim();

    return (
      this.#parseVScaleGrade(trimmedInput) ?? this.#parseYosemiteDecimalSystemGrade(trimmedInput)
    );
  }

  #parseVScaleGrade(input: string): ParsedClimbingGrade | null {
    const match = vScalePattern.exec(input);
    const matchedGrade = match?.groups?.grade;
    if (!matchedGrade) {
      return null;
    }

    if (matchedGrade.toUpperCase() === "B") {
      return {
        gradeSystem: "v_scale",
        grade: "VB",
        sortValue: -1,
      };
    }

    const sortValue = Number.parseInt(matchedGrade, 10);
    if (!Number.isSafeInteger(sortValue)) {
      return null;
    }

    return {
      gradeSystem: "v_scale",
      grade: `V${sortValue}`,
      sortValue,
    };
  }

  #parseYosemiteDecimalSystemGrade(input: string): ParsedClimbingGrade | null {
    const match = yosemiteDecimalSystemPattern.exec(input);
    const matchedMajorGrade = match?.groups?.majorGrade;
    if (!matchedMajorGrade) {
      return null;
    }

    const majorGrade = Number.parseInt(matchedMajorGrade, 10);
    if (!Number.isInteger(majorGrade) || majorGrade < 0 || majorGrade > 15) {
      return null;
    }

    const modifier = match.groups?.modifier?.toLowerCase();
    const sortValue = this.#computeYosemiteDecimalSystemSortValue(majorGrade, modifier);
    if (sortValue === null) {
      return null;
    }

    return {
      gradeSystem: "yds",
      grade: `5.${majorGrade}${modifier ?? ""}`,
      sortValue,
    };
  }

  #computeYosemiteDecimalSystemSortValue(
    majorGrade: number,
    modifier: string | undefined,
  ): number | null {
    const baseSortValue = 5000 + majorGrade * 10;

    if (!modifier) {
      return baseSortValue;
    }

    if (modifier === "-") {
      return baseSortValue - 3;
    }

    if (modifier === "+") {
      return baseSortValue + 5;
    }

    const letterSortOffset = yosemiteLetterSortOffsets.get(modifier);
    if (letterSortOffset === undefined) {
      return null;
    }

    return baseSortValue + letterSortOffset;
  }
}

const climbingGradeParser = new ClimbingGradeParser();

export function parseClimbingGrade(input: string): ParsedClimbingGrade | null {
  return climbingGradeParser.parse(input);
}
