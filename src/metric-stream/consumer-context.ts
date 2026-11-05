import type { MetricStreamPosition } from "./transport-position.ts";

export interface MetricStreamConsumerBatchContext {
  topic: string;
  partition: number;
  positions: readonly MetricStreamPosition[];
  assertActive(): Promise<void>;
}
