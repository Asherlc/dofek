import type {} from "bullmq";

declare module "bullmq" {
  interface IRedisClient {
    set(
      key: string,
      value: string | number,
      mode: "PX",
      millisecondsToExpire: number,
    ): Promise<"OK" | null>;
    set(
      key: string,
      value: string | number,
      mode: "PX",
      millisecondsToExpire: number,
      condition: "NX",
    ): Promise<"OK" | null>;
    watch(...keys: string[]): Promise<"OK">;
    unwatch(): Promise<"OK">;
    exists(key: string): Promise<number>;
    sadd(key: string, ...members: string[]): Promise<number>;
    srem(key: string, ...members: string[]): Promise<number>;
    scard(key: string): Promise<number>;
    expire(key: string, seconds: number): Promise<number>;
    eval(script: string, keyCount: number, ...args: Array<string | number>): Promise<unknown>;
    scan(
      cursor: string,
      matchKeyword: "MATCH",
      pattern: string,
      countKeyword: "COUNT",
      count: string,
    ): Promise<[string, string[]]>;
  }

  interface IRedisTransaction {
    set(key: string, value: string | number, mode: "PX", millisecondsToExpire: number): this;
  }
}
