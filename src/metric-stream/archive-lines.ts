/** Exact JSONL payload bytes; LF alone is the delimiter and CR remains payload. */
export async function* readMetricStreamArchiveLines(
  source: AsyncIterable<Uint8Array>,
  maxLineBytes: number,
): AsyncGenerator<{ payload: Buffer; lineOrdinal: number; terminated: boolean }> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0)
    throw new Error("Archive line byte limit must be a positive safe integer");
  const parts: Buffer[] = [];
  let lineBytes = 0;
  let lineOrdinal = 0;
  const append = (part: Buffer) => {
    lineBytes += part.byteLength;
    if (lineBytes > maxLineBytes)
      throw new Error(
        `Archive line payload exceeds its ${maxLineBytes}-byte limit at line ${lineOrdinal + 1}; contact support before retrying`,
      );
    if (part.byteLength) parts.push(Buffer.from(part));
  };
  const line = (terminated: boolean) => {
    const payload = Buffer.concat(parts, lineBytes);
    parts.length = 0;
    lineBytes = 0;
    lineOrdinal += 1;
    return { payload, lineOrdinal, terminated };
  };
  for await (const chunk of source) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let start = 0;
    for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, start)) {
      append(bytes.subarray(start, end));
      yield line(true);
      start = end + 1;
    }
    append(bytes.subarray(start));
  }
  if (lineBytes) yield line(false);
}
