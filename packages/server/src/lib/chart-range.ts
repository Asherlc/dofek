import type { UnsetMarker } from "@trpc/server/unstable-core-do-not-import";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import type { AuthenticatedContext } from "../trpc.ts";
import { cachedProtectedQuery } from "../trpc.ts";
import {
  clickHouseDateRangeLowerBound,
  clickHouseDateRangePredicate,
  clickHouseMondayDateRangeLowerBound,
  clickHouseRangeLowerBound,
  clickHouseToIntervalDayLowerBound,
  clickHouseWindowStartPredicate,
  currentDateRangePredicate,
  dateWindowStartPredicate,
  dateWindowStartString,
  postgresCurrentTimestampRangeLowerBound,
  postgresEndDateTimestampRangeLowerBound,
  type RangeDays,
  type RangeOperator,
  rangeDaysParams,
  SELECTED_CHART_RANGE_ENDPOINTS,
  type SelectedChartRangeEndpoint,
  selectedChartDateRangeInput,
  selectedChartRangeDaysSchema,
  selectedChartRangeInput,
} from "./date-window.ts";

type MaybePromise<T> = T | Promise<T>;
type ProcedureInput<TInput> = TInput extends UnsetMarker ? undefined : TInput;
type ParsedChartRangeInput<TInput extends { days: RangeDays }> = Exclude<
  ProcedureInput<TInput>,
  undefined
>;

interface SelectedChartRangeResolveArgs<TInput> {
  ctx: AuthenticatedContext;
  input: TInput;
  range: ChartRange;
}

function hasSelectedChartRangeInput<TInput extends { days: RangeDays }>(
  input: ProcedureInput<TInput>,
): input is ParsedChartRangeInput<TInput> {
  return input !== undefined;
}

export class ChartRange {
  readonly #days: RangeDays;

  constructor(days: RangeDays) {
    this.#days = days;
  }

  static fromDays(days: RangeDays): ChartRange {
    return new ChartRange(days);
  }

  get days(): RangeDays {
    return this.#days;
  }

  isAll(): boolean {
    return this.#days === null;
  }

  withWarmupDays(extraDays: number): ChartRange {
    return this.#days === null ? this : new ChartRange(this.#days + extraDays);
  }

  params(parameterName = "days"): Record<string, number> {
    return rangeDaysParams(this.#days, parameterName);
  }

  clickHouseParams(parameterName = "days"): Record<string, number> {
    return this.params(parameterName);
  }

  clickHouseTimestampAfter(column: string, parameterName = "days"): string {
    return clickHouseRangeLowerBound(this.#days, column, parameterName);
  }

  clickHouseTimestampAfterToIntervalDay(column: string, parameterName = "days"): string {
    return clickHouseToIntervalDayLowerBound(this.#days, column, parameterName);
  }

  clickHouseDateAfterToday(column: string, parameterName = "days"): string {
    return clickHouseDateRangeLowerBound(this.#days, column, parameterName);
  }

  clickHouseMondayAfterToday(
    column: string,
    parameterName = "days",
    operator: RangeOperator = ">",
  ): string {
    return clickHouseMondayDateRangeLowerBound(this.#days, column, parameterName, operator);
  }

  postgresTimestampAfterNow(column: SQL): SQL {
    return postgresCurrentTimestampRangeLowerBound(this.#days, column);
  }

  postgresTimestampAfterCurrentTimestamp(column: SQL): SQL {
    return postgresCurrentTimestampRangeLowerBound(this.#days, column);
  }

  postgresTimestampAfterEndDate(column: SQL, endDate: string): SQL {
    return postgresEndDateTimestampRangeLowerBound(this.#days, column, endDate);
  }

  postgresDateAfterEndDate(column: SQL, endDate: string, operator: RangeOperator = ">"): SQL {
    return dateWindowStartPredicate(column, endDate, this.#days, operator);
  }

  currentDateAfter(column: SQL, operator: RangeOperator = ">"): SQL {
    return currentDateRangePredicate(column, this.#days, operator);
  }

  windowStartString(endDate: string): string | undefined {
    return this.#days === null ? undefined : dateWindowStartString(endDate, this.#days);
  }

  clickHouseDateAfterEndDate(input: {
    expression: string;
    operator?: RangeOperator;
    endDateExpression?: string;
  }): string {
    return clickHouseDateRangePredicate({
      expression: input.expression,
      days: this.#days,
      operator: input.operator,
      endDateExpression: input.endDateExpression,
    });
  }

  clickHouseDateAfterWindowStart(input: {
    expression: string;
    operator?: RangeOperator;
    paramName?: string;
  }): string {
    return clickHouseWindowStartPredicate({
      expression: input.expression,
      days: this.#days,
      operator: input.operator,
      paramName: input.paramName,
    });
  }
}

export function selectedChartRangeQuery<TResult>(
  endpoint: SelectedChartRangeEndpoint,
  ttlMs: number,
  resolve: (args: SelectedChartRangeResolveArgs<{ days: RangeDays }>) => MaybePromise<TResult>,
  options: {
    min?: number;
    max?: number;
    outputSchema?: z.ZodType<TResult>;
    keyVersion?: string;
  } = {},
) {
  assertSelectedChartInputKind(endpoint, "days");
  return cachedProtectedQuery({ maxAge: ttlMs, keyVersion: options.keyVersion })
    .input(selectedChartRangeInput(endpoint, options))
    .output(options.outputSchema ?? z.custom<TResult>())
    .query(({ ctx, input }) =>
      resolve({
        ctx,
        input,
        range: ChartRange.fromDays(input.days),
      }),
    );
}

export function selectedChartRangeSchema(
  endpoint: SelectedChartRangeEndpoint,
  options: { min?: number; max?: number } = {},
) {
  return selectedChartRangeDaysSchema(endpoint, options);
}

export function selectedChartCustomRangeQuery<TInput extends { days: RangeDays }, TResult>(
  endpoint: SelectedChartRangeEndpoint,
  ttlMs: number,
  inputSchema: z.ZodType<TInput>,
  resolve: (
    args: SelectedChartRangeResolveArgs<ParsedChartRangeInput<TInput>>,
  ) => MaybePromise<TResult>,
  outputSchema: z.ZodType<TResult> = z.custom<TResult>(),
  options: { keyVersion?: string } = {},
) {
  assertSelectedChartInputKind(endpoint, "custom");
  return cachedProtectedQuery({ maxAge: ttlMs, keyVersion: options.keyVersion })
    .input(inputSchema)
    .output(outputSchema)
    .query(({ ctx, input }) => {
      if (!hasSelectedChartRangeInput(input)) {
        throw new Error(`${endpoint} selected chart range input is required`);
      }
      return resolve({
        ctx,
        input,
        range: ChartRange.fromDays(input.days),
      });
    });
}

export function selectedChartDateRangeQuery<TResult>(
  endpoint: SelectedChartRangeEndpoint,
  ttlMs: number,
  resolve: (
    args: SelectedChartRangeResolveArgs<{ days: RangeDays; endDate: string }>,
  ) => MaybePromise<TResult>,
  options: {
    min?: number;
    max?: number;
    outputSchema?: z.ZodType<TResult>;
    keyVersion?: string;
  } = {},
) {
  assertSelectedChartInputKind(endpoint, "dateRange");
  return cachedProtectedQuery({ maxAge: ttlMs, keyVersion: options.keyVersion })
    .input(selectedChartDateRangeInput(endpoint, options))
    .output(options.outputSchema ?? z.custom<TResult>())
    .query(({ ctx, input }) =>
      resolve({
        ctx,
        input,
        range: ChartRange.fromDays(input.days),
      }),
    );
}

function assertSelectedChartInputKind(
  endpoint: SelectedChartRangeEndpoint,
  expectedInputKind: "days" | "dateRange" | "custom",
): void {
  const actualInputKind = SELECTED_CHART_RANGE_ENDPOINTS[endpoint].input;
  if (actualInputKind !== expectedInputKind) {
    throw new Error(
      `${endpoint} must use ${actualInputKind} selected chart range input, not ${expectedInputKind}`,
    );
  }
}
