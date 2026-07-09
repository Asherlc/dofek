import { type SQL, sql } from "drizzle-orm";
import type { z } from "zod";
import type { AuthenticatedContext } from "../trpc.ts";
import { cachedProtectedQuery } from "../trpc.ts";
import {
  dateWindowStart,
  dateWindowStartString,
  type RangeDays,
  type RangeOperator,
  SELECTED_CHART_RANGE_ENDPOINTS,
  type SelectedChartRangeEndpoint,
  selectedChartDateRangeInput,
  selectedChartRangeDaysSchema,
  selectedChartRangeInput,
  timestampWindowStart,
} from "./date-window.ts";

type MaybePromise<T> = T | Promise<T>;

interface SelectedChartRangeResolveArgs<TInput> {
  ctx: AuthenticatedContext;
  input: TInput;
  range: ChartRange;
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
    return this.#days === null ? {} : { [parameterName]: this.#days };
  }

  clickHouseParams(parameterName = "days"): Record<string, number> {
    return this.params(parameterName);
  }

  clickHouseTimestampAfter(column: string, parameterName = "days"): string {
    return this.#days === null
      ? ""
      : `AND ${column} > now() - INTERVAL {${parameterName}:Int32} DAY`;
  }

  clickHouseTimestampAfterToIntervalDay(column: string, parameterName = "days"): string {
    return this.#days === null
      ? ""
      : `AND ${column} > now() - toIntervalDay({${parameterName}:UInt32})`;
  }

  clickHouseDateAfterToday(column: string, parameterName = "days"): string {
    return this.#days === null
      ? ""
      : `AND ${column} > today() - INTERVAL {${parameterName}:Int32} DAY`;
  }

  clickHouseMondayAfterToday(
    column: string,
    parameterName = "days",
    operator: RangeOperator = ">",
  ): string {
    return this.#days === null
      ? ""
      : `AND ${column} ${operator} toMonday(today() - INTERVAL {${parameterName}:Int32} DAY)`;
  }

  postgresTimestampAfterNow(column: SQL): SQL {
    if (this.#days === null) return sql``;
    return sql`AND ${column} > NOW() - ${this.#days}::int * INTERVAL '1 day'`;
  }

  postgresTimestampAfterCurrentTimestamp(column: SQL): SQL {
    if (this.#days === null) return sql``;
    return sql`AND ${column} > CURRENT_TIMESTAMP - ${this.#days}::int * INTERVAL '1 day'`;
  }

  postgresTimestampAfterEndDate(column: SQL, endDate: string): SQL {
    if (this.#days === null) return sql``;
    return sql`AND ${column} > ${timestampWindowStart(endDate, this.#days)}`;
  }

  postgresDateAfterEndDate(column: SQL, endDate: string, operator: RangeOperator = ">"): SQL {
    if (this.#days === null) return sql``;
    return operator === ">="
      ? sql`AND ${column} >= ${dateWindowStart(endDate, this.#days)}`
      : sql`AND ${column} > ${dateWindowStart(endDate, this.#days)}`;
  }

  currentDateAfter(column: SQL, operator: RangeOperator = ">"): SQL {
    if (this.#days === null) return sql``;
    return operator === ">="
      ? sql`AND ${column} >= (CURRENT_DATE - ${this.#days}::int)`
      : sql`AND ${column} > CURRENT_DATE - ${this.#days}::int`;
  }

  windowStartString(endDate: string): string | undefined {
    return this.#days === null ? undefined : dateWindowStartString(endDate, this.#days);
  }

  clickHouseDateAfterEndDate(input: {
    expression: string;
    operator?: RangeOperator;
    endDateExpression?: string;
  }): string {
    if (this.#days === null) return "";
    const operator = input.operator ?? ">";
    const endDateExpression = input.endDateExpression ?? "toDate({endDate:String})";
    return `AND ${input.expression} ${operator} subtractDays(${endDateExpression}, {days:UInt32})`;
  }

  clickHouseDateAfterWindowStart(input: {
    expression: string;
    operator?: RangeOperator;
    paramName?: string;
  }): string {
    if (this.#days === null) return "";
    const operator = input.operator ?? ">";
    const paramName = input.paramName ?? "windowStart";
    return `AND ${input.expression} ${operator} toDate({${paramName}:String})`;
  }
}

export function selectedChartRangeQuery<TResult>(
  endpoint: SelectedChartRangeEndpoint,
  ttlMs: number,
  resolve: (args: SelectedChartRangeResolveArgs<{ days: RangeDays }>) => MaybePromise<TResult>,
  options: { min?: number; max?: number } = {},
) {
  assertSelectedChartInputKind(endpoint, "days");
  return cachedProtectedQuery({ maxAge: ttlMs })
    .input(selectedChartRangeInput(endpoint, options))
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

export function selectedChartCustomRangeQuery<
  TInputSchema extends z.ZodType<{ days: RangeDays }>,
  TResult,
>(
  endpoint: SelectedChartRangeEndpoint,
  ttlMs: number,
  inputSchema: TInputSchema,
  resolve: (args: SelectedChartRangeResolveArgs<z.output<TInputSchema>>) => MaybePromise<TResult>,
) {
  assertSelectedChartInputKind(endpoint, "custom");
  return cachedProtectedQuery({ maxAge: ttlMs })
    .input(inputSchema)
    .query(({ ctx, input }) => {
      if (input === undefined) {
        throw new Error(`${endpoint} selected chart range input is required`);
      }
      const parsedInput = inputSchema.parse(input);
      return resolve({
        ctx,
        input: parsedInput,
        range: ChartRange.fromDays(parsedInput.days),
      });
    });
}

export function selectedChartDateRangeQuery<TResult>(
  endpoint: SelectedChartRangeEndpoint,
  ttlMs: number,
  resolve: (
    args: SelectedChartRangeResolveArgs<{ days: RangeDays; endDate: string }>,
  ) => MaybePromise<TResult>,
  options: { min?: number; max?: number } = {},
) {
  assertSelectedChartInputKind(endpoint, "dateRange");
  return cachedProtectedQuery({ maxAge: ttlMs })
    .input(selectedChartDateRangeInput(endpoint, options))
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
