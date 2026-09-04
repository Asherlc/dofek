declare module "@openbeta/sandbag" {
  export interface SandbagGradeScale {
    conversionGroup: string;
    getScore(grade: string): number | [number, number];
    grades: string[];
    isType(grade: string): boolean;
  }

  export const GradeScales: {
    readonly VSCALE: "vscale";
    readonly FONT: "font";
    readonly YDS: "yds";
    readonly FRENCH: "french";
    readonly UIAA: "uiaa";
    readonly EWBANK: "ewbank";
    readonly SAXON: "saxon";
    readonly NORWEGIAN: "norwegian";
    readonly BRAZILIAN_CRUX: "brazilian_crux";
  };

  export function convertGrade(
    fromGrade: string,
    fromScale: (typeof GradeScales)[keyof typeof GradeScales],
    toScale: (typeof GradeScales)[keyof typeof GradeScales],
  ): string;

  export function getScale(
    scale: (typeof GradeScales)[keyof typeof GradeScales],
  ): SandbagGradeScale | null;
}
