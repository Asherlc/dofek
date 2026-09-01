import { describe, expect, it } from "vitest";

import {
  activityModalityEnum,
  canonicalActivityTypeEnum,
  foodCategoryEnum,
  mealEnum,
  setTypeEnum,
  sleepStageNameEnum,
} from "./enums.ts";

describe("schema enums", () => {
  it("defines the meal enum values", () => {
    expect(mealEnum.enumName).toBe("meal");
    expect(mealEnum.enumValues).toEqual(["breakfast", "lunch", "dinner", "snack", "other"]);
  });

  it("defines food categories for standard foods, supplements, and uncategorized entries", () => {
    expect(foodCategoryEnum.enumName).toBe("food_category");
    expect(foodCategoryEnum.enumValues).toEqual(
      expect.arrayContaining(["beans_and_legumes", "supplement", "other"]),
    );
    expect(foodCategoryEnum.enumValues).toHaveLength(19);
  });

  it("defines strength set type values", () => {
    expect(setTypeEnum.enumName).toBe("set_type");
    expect(setTypeEnum.enumValues).toEqual(["working", "warmup", "dropset", "failure"]);
  });

  it("defines sleep stage name values", () => {
    expect(sleepStageNameEnum.enumName).toBe("sleep_stage_name");
    expect(sleepStageNameEnum.enumValues).toEqual(["deep", "light", "rem", "awake"]);
  });

  it("defines canonical activity types and orthogonal modalities", () => {
    expect(canonicalActivityTypeEnum.enumName).toBe("canonical_activity_type");
    expect(canonicalActivityTypeEnum.enumValues).toEqual(
      expect.arrayContaining(["cycling", "running", "strength", "yoga", "swimming", "other"]),
    );
    expect(activityModalityEnum.enumName).toBe("activity_modality");
    expect(activityModalityEnum.enumValues).toEqual(
      expect.arrayContaining(["road", "mountain", "indoor", "virtual", "trail"]),
    );
  });
});
