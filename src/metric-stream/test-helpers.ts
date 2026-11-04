export function kafkaTestPositions(
  offsets: readonly string[],
  topic = "metric-stream-v1",
  partition = 2,
) {
  return offsets.map((offset) => ({
    transport: "kafka" as const,
    epoch: "test-epoch",
    topic,
    partition,
    offset,
  }));
}
