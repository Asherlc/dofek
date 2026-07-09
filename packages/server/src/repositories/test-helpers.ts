import { expect } from "vitest";

export function collectSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  const queryChunks = Reflect.get(value, "queryChunks");
  if (Array.isArray(queryChunks)) {
    return queryChunks.map((queryChunk) => collectSqlText(queryChunk)).join("");
  }
  const rawValue = Reflect.get(value, "value");
  if (Array.isArray(rawValue)) {
    return rawValue.map((rawChunk) => collectSqlText(rawChunk)).join("");
  }
  if (typeof rawValue === "string") return rawValue;
  return "";
}

export function expectClickHouseFiniteDaysFilter(
  query: string | undefined,
  params: Record<string, unknown> | undefined,
): void {
  expect(query).toContain("INTERVAL {days:Int32} DAY");
  expect(params).toHaveProperty("days", 30);
}

export function expectClickHouseUnboundedDaysFilter(
  query: string | undefined,
  params: Record<string, unknown> | undefined,
): void {
  expect(query).not.toContain("INTERVAL {days:Int32} DAY");
  expect(params).not.toHaveProperty("days");
}

export function expectSensorStoreFiniteDaysFilter(
  sensorStore: {
    query: {
      mock: { calls: Array<[unknown, string | undefined, Record<string, unknown> | undefined]> };
    };
  },
  callIndex = 0,
): void {
  const query = sensorStore.query.mock.calls[callIndex]?.[1];
  const params = sensorStore.query.mock.calls[callIndex]?.[2];
  expectClickHouseFiniteDaysFilter(query, params);
}

export function expectSensorStoreUnboundedDaysFilter(
  sensorStore: {
    query: {
      mock: { calls: Array<[unknown, string | undefined, Record<string, unknown> | undefined]> };
    };
  },
  callIndex = 0,
): void {
  const query = sensorStore.query.mock.calls[callIndex]?.[1];
  const params = sensorStore.query.mock.calls[callIndex]?.[2];
  expectClickHouseUnboundedDaysFilter(query, params);
}
