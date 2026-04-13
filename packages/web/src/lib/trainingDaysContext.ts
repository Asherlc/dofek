import { createDaysContext } from "./createDaysContext.ts";

const { DaysContext: TrainingDaysContext, useDays: useTrainingDays } = createDaysContext(180);

export { TrainingDaysContext, useTrainingDays };
