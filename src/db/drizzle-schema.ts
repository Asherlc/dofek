import * as accountSchema from "./schema/account.ts";
import * as activitySchema from "./schema/activity.ts";
import * as clinicalSchema from "./schema/clinical.ts";
import * as coreSchema from "./schema/core.ts";
import * as enumSchema from "./schema/enums.ts";
import * as eventSchema from "./schema/events.ts";
import * as nutritionSchema from "./schema/nutrition.ts";
import * as processingSchema from "./schema/processing.ts";
import * as referenceSchema from "./schema/reference.ts";

export const drizzleSchema = {
  ...coreSchema,
  ...enumSchema,
  ...referenceSchema,
  ...activitySchema,
  ...nutritionSchema,
  ...clinicalSchema,
  ...accountSchema,
  ...eventSchema,
  ...processingSchema,
};
