import { jsonToolResult } from "./tool-result.ts";

export function jsonContent(value: unknown) {
  return { content: jsonToolResult(value).content };
}

export async function mapWithConcurrency<TValue, TResult>(
  values: readonly TValue[],
  concurrency: number,
  mapper: (value: TValue, index: number) => Promise<TResult>,
): Promise<TResult[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  const results = new Array<TResult>(values.length);
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value === undefined) {
        throw new Error(`Missing input at index ${index}`);
      }
      results[index] = await mapper(value, index);
    }
  }
  const workerCount = Math.min(concurrency, values.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

export function assertDateRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error("start_date must be on or before end_date");
  }
}
