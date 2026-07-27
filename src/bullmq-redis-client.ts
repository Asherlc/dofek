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
    type(key: string): Promise<string>;
    del(...keys: string[]): Promise<number>;
    get(key: string): Promise<string | null>;
    smembers(key: string): Promise<string[]>;
    info(section: "persistence"): Promise<string>;
    bgsave(schedule: "SCHEDULE"): Promise<string>;
    bgrewriteaof(): Promise<string>;
    xrange(
      key: string,
      start: string,
      end: string,
      countKeyword: "COUNT",
      count: number,
    ): Promise<Array<[string, string[]]>>;
    xdel(key: string, ...ids: string[]): Promise<number>;
  }

  interface IRedisTransaction {
    set(key: string, value: string | number, mode: "PX", millisecondsToExpire: number): this;
  }
}
