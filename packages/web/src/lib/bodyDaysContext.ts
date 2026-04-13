import { createDaysContext } from "./createDaysContext.ts";

export const { DaysContext: BodyDaysContext, useDays: useBodyDays } = createDaysContext(30);
