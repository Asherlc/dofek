export interface RedisCompareAndSetClient {
  get: (key: string) => Promise<string | null>;
  eval: (
    script: string,
    numberOfKeys: number,
    key: string,
    hasPrevious: string,
    previous: string,
    next: string,
    ttlMs: number,
  ) => Promise<unknown>;
}

// WATCH belongs to the shared connection. Compare and write in one Redis command.
const COMPARE_AND_SET = `
local current = redis.call('GET', KEYS[1])
if (ARGV[1] == '0' and current ~= false) or
   (ARGV[1] == '1' and current ~= ARGV[2]) then
  return 0
end
redis.call('SET', KEYS[1], ARGV[3], 'PX', ARGV[4])
return 1
`;

export async function compareAndSetRedisValue(
  redis: RedisCompareAndSetClient,
  key: string,
  previous: string | null,
  next: string,
  ttlMs: number,
): Promise<boolean> {
  return (
    (await redis.eval(
      COMPARE_AND_SET,
      1,
      key,
      previous === null ? "0" : "1",
      previous ?? "",
      next,
      ttlMs,
    )) === 1
  );
}
