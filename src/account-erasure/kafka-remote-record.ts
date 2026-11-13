/** Pinned Kafka 4.4 native remote metadata v0 records, not a general protocol codec.
 * https://github.com/apache/kafka/tree/4.4.0/storage/src/main/resources/message
 * KafkaJS handles record batches/compression; this reads only the native value.
 */
export function decodeKafkaRemoteRecord(data: Buffer) {
  let position = 0;
  const take = (length: number): Buffer => {
    if (length < 0 || position + length > data.length)
      throw new Error("Truncated Kafka remote metadata");
    const value = data.subarray(position, position + length);
    position += length;
    return value;
  };
  const uint = (): number => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = take(1)[0];
      if (byte === undefined) throw new Error("Missing Kafka remote metadata byte");
      value += (byte & 127) * 2 ** shift;
      if (byte < 128 && value <= 0x7fffffff) return value;
    }
    throw new Error("Invalid Kafka remote metadata integer");
  };
  const tags = (allowTxnIndex = false) => {
    const count = uint();
    if (count > (allowTxnIndex ? 1 : 0)) throw new Error("Unknown Kafka remote metadata tags");
    for (let i = 0; i < count; i++) {
      const tag = uint();
      const value = take(uint());
      // Only the pinned TxnIndexEmpty tagged field is understood.
      if (tag !== 0 || value.length !== 1 || (value[0] !== 0 && value[0] !== 1))
        throw new Error("Unknown Kafka remote metadata tag");
    }
  };
  if (uint() !== 1) throw new Error("Unsupported Kafka remote metadata frame");
  const type = uint();
  if ((type !== 0 && type !== 1) || uint() !== 0)
    throw new Error("Unsupported Kafka remote metadata record/version");
  const topic = take(uint() - 1).toString("utf8");
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,248}$/.test(topic))
    throw new Error("Invalid Kafka remote metadata topic");
  const topicId = take(16).toString("base64url");
  const partition = take(4).readInt32BE();
  tags();
  const segmentId = take(16).toString("base64url");
  tags();
  let range: { startOffset: string; endOffset: string } | undefined;
  if (type === 0) {
    const start = take(8).readBigInt64BE();
    const end = take(8).readBigInt64BE();
    if (start < 0n || end < start) throw new Error("Invalid Kafka remote segment range");
    range = { startOffset: String(start), endOffset: String(end) };
    take(20); // broker, maximum timestamp, event timestamp
    const epochs = uint() - 1;
    if (epochs < 1) throw new Error("Missing Kafka remote segment leader epochs");
    for (let i = 0; i < epochs; i++) {
      take(12);
      tags();
    }
    if (take(4).readInt32BE() < 0) throw new Error("Invalid Kafka remote segment size");
  } else {
    take(12); // broker and event timestamp
  }
  const customLength = uint();
  if (customLength > 0) take(customLength - 1);
  const state = take(1)[0];
  if (partition < 0 || state === undefined || state > 3 || (type === 0 && state !== 0))
    throw new Error("Invalid Kafka remote segment state/partition");
  tags(type === 0);
  if (position !== data.length) throw new Error("Trailing Kafka remote metadata bytes");
  return { topic, topicId, partition, segmentId, ...range, state };
}
