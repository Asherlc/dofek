export interface LogEntry {
  level: string;
  message: string;
  timestamp: string;
}

/**
 * Fixed-size circular buffer for log entries.
 * When the buffer is full, the oldest entry is evicted. Entries are always
 * returned in chronological (insertion) order.
 */
export class RingBuffer {
  readonly maxSize: number;
  private buffer: LogEntry[];
  private head = 0;
  private count = 0;

  constructor(maxSize = 500) {
    this.maxSize = maxSize;
    this.buffer = new Array<LogEntry>(maxSize);
  }

  push(entry: LogEntry): void {
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  /** Return all buffered entries in chronological order. */
  getEntries(): LogEntry[] {
    if (this.count === 0) return [];

    if (this.count < this.maxSize) {
      // Buffer hasn't wrapped yet — entries are 0..count-1
      return this.buffer.slice(0, this.count);
    }

    // Buffer has wrapped — oldest entry is at head, read head..end then 0..head-1
    return [...this.buffer.slice(this.head), ...this.buffer.slice(0, this.head)];
  }
}
