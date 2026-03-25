/**
 * Parse a Bluetooth HCI packet capture (.btsnoop or .pklg) to extract
 * Whoop BLE sensor data — accelerometer/IMU, heart rate, and raw packets.
 *
 * Usage:
 *   npx tsx scripts/parse-whoop-ble-capture.ts <capture-file> [--raw]
 *
 * Protocol reverse-engineered from WHOOP Android APK v5.439.0.
 *
 * Whoop BLE GATT characteristics (same offset pattern for all gens):
 *   CMD_TO_STRAP:      ...0002  (write)
 *   CMD_FROM_STRAP:    ...0003  (notify)
 *   EVENTS_FROM_STRAP: ...0004  (notify)
 *   DATA_FROM_STRAP:   ...0005  (notify)  <-- sensor data arrives here
 *   MEMFAULT:          ...0007  (notify)
 *
 * Service UUIDs:
 *   GEN_4 (Harvard):   61080001-8d6d-82b8-614a-1c8cb0f8dcc6
 *   MAVERICK/GOOSE:    fd4b0001-cce1-4033-93ce-002d5875f58a
 *   PUFFIN:            11500001-6215-11ee-8c99-0242ac120002
 */

import { readFileSync, writeFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Whoop protocol constants
// ---------------------------------------------------------------------------

const SOF = 0xaa;

/** PacketType byte (offset 0 in payload) */
const PacketType = {
  COMMAND: 0x23,
  COMMAND_RESPONSE: 0x24,
  PUFFIN_COMMAND: 0x25,
  PUFFIN_COMMAND_RESPONSE: 0x26,
  REALTIME_DATA: 0x28,
  REALTIME_RAW_DATA: 0x2b,
  HISTORICAL_DATA: 0x2f,
  EVENT: 0x30,
  METADATA: 0x31,
  CONSOLE_LOGS: 0x32,
  REALTIME_IMU: 0x33,
  HISTORICAL_IMU: 0x34,
  RELATIVE_PUFFIN_EVENTS: 0x35,
  PUFFIN_EVENTS: 0x36,
  BATTERY_PACK_LOGS: 0x37,
  PUFFIN_METADATA: 0x38,
} as const;

const PacketTypeName: Record<number, string> = {};
for (const [name, value] of Object.entries(PacketType)) {
  PacketTypeName[value] = name;
}

/** Command number byte (offset 2 in command packets) */
const CommandName: Record<number, string> = {
  3: "TOGGLE_REALTIME_HR",
  7: "REPORT_VERSION_INFO",
  10: "SET_CLOCK",
  11: "GET_CLOCK",
  16: "TOGGLE_R7_DATA_COLLECTION",
  20: "ABORT_HISTORICAL_TRANSMITS",
  22: "SEND_HISTORICAL_DATA",
  23: "HISTORICAL_DATA_RESULT",
  26: "GET_BATTERY_LEVEL",
  33: "SET_READ_POINTER",
  34: "GET_DATA_RANGE",
  81: "START_RAW_DATA",
  82: "STOP_RAW_DATA",
  96: "ENTER_HIGH_FREQ_SYNC",
  97: "EXIT_HIGH_FREQ_SYNC",
  105: "TOGGLE_IMU_MODE_HISTORICAL",
  106: "TOGGLE_IMU_MODE",
  107: "ENABLE_OPTICAL_DATA",
  108: "TOGGLE_OPTICAL_MODE",
  139: "TOGGLE_LABRADOR_FILTERED",
  145: "GET_HELLO",
  153: "TOGGLE_PERSISTENT_R20",
  154: "TOGGLE_PERSISTENT_R21",
};

/** Whoop DATA_FROM_STRAP characteristic handle suffixes */
const DATA_CHAR_SUFFIXES = ["0005"];
const CMD_CHAR_SUFFIXES = ["0002"];

// ---------------------------------------------------------------------------
// btsnoop / pklg file parsers
// ---------------------------------------------------------------------------

interface HciPacket {
  timestamp: number;
  direction: "send" | "recv";
  data: Buffer;
}

function parseBtsnoop(buf: Buffer): HciPacket[] {
  // btsnoop format: https://www.ietf.org/rfc/rfc1761.txt
  // 16-byte header: "btsnoop\0" + version(4) + datalink(4)
  const magic = buf.toString("ascii", 0, 8);
  if (magic !== "btsnoop\0") return [];

  const packets: HciPacket[] = [];
  let offset = 16;

  while (offset + 24 <= buf.length) {
    const origLen = buf.readUInt32BE(offset);
    const inclLen = buf.readUInt32BE(offset + 4);
    const flags = buf.readUInt32BE(offset + 8);
    // timestamp is 8 bytes at offset+16 (microseconds since epoch)
    const tsHi = buf.readUInt32BE(offset + 16);
    const tsLo = buf.readUInt32BE(offset + 20);
    const timestamp = (tsHi * 0x100000000 + tsLo) / 1000; // to ms

    const direction = (flags & 1) === 0 ? "send" : "recv";
    const data = buf.subarray(offset + 24, offset + 24 + inclLen);

    packets.push({ timestamp, direction, data });
    offset += 24 + inclLen;
  }

  return packets;
}

function parsePklg(buf: Buffer): HciPacket[] {
  // Apple PacketLogger format: sequence of records
  // Each record: [len:4 LE] [ts:8 LE (mach_absolute_time)] [type:1] [data...]
  const packets: HciPacket[] = [];
  let offset = 0;

  while (offset + 13 <= buf.length) {
    const len = buf.readUInt32LE(offset);
    if (len < 9 || offset + 4 + len > buf.length) break;

    const tsLo = buf.readUInt32LE(offset + 4);
    const tsHi = buf.readUInt32LE(offset + 8);
    const timestamp = tsHi * 0x100000000 + tsLo;
    const pktType = buf[offset + 12];

    // type 0x00 = HCI command, 0x01 = HCI event, 0x02 = ACL sent, 0x03 = ACL recv
    const direction = pktType === 0x00 || pktType === 0x02 ? "send" : "recv";
    const data = buf.subarray(offset + 13, offset + 4 + len);

    packets.push({ timestamp, direction, data });
    offset += 4 + len;
  }

  return packets;
}

// ---------------------------------------------------------------------------
// ATT/GATT layer extraction
// ---------------------------------------------------------------------------

interface AttNotification {
  handle: number;
  value: Buffer;
  timestamp: number;
}

interface AttWrite {
  handle: number;
  value: Buffer;
  timestamp: number;
}

function extractAttFromAcl(packets: HciPacket[]) {
  const notifications: AttNotification[] = [];
  const writes: AttWrite[] = [];

  for (const pkt of packets) {
    const d = pkt.data;
    if (d.length < 9) continue;

    // ACL header: handle(2) + len(2), then L2CAP: len(2) + CID(2)
    // We want CID = 0x0004 (ATT)
    const l2capLen = d.readUInt16LE(4);
    const cid = d.readUInt16LE(6);
    if (cid !== 0x0004) continue;

    const attOpcode = d[8];

    // ATT Handle Value Notification (0x1B): handle(2) + value
    if (attOpcode === 0x1b && d.length >= 11) {
      const handle = d.readUInt16LE(9);
      const value = Buffer.from(d.subarray(11));
      notifications.push({ handle, value, timestamp: pkt.timestamp });
    }

    // ATT Write Request (0x12) or Write Command (0x52): handle(2) + value
    if ((attOpcode === 0x12 || attOpcode === 0x52) && d.length >= 11) {
      const handle = d.readUInt16LE(9);
      const value = Buffer.from(d.subarray(11));
      writes.push({ handle, value, timestamp: pkt.timestamp });
    }
  }

  return { notifications, writes };
}

// ---------------------------------------------------------------------------
// Whoop frame parser
// ---------------------------------------------------------------------------

interface WhoopPacket {
  timestamp: number;
  packetType: number;
  packetTypeName: string;
  recordType: number;
  dataTimestamp: number;
  subSeconds: number;
  payload: Buffer;
}

/** Accumulate BLE notification chunks into complete Whoop frames */
function parseWhoopFrames(notifications: AttNotification[]): WhoopPacket[] {
  const packets: WhoopPacket[] = [];
  let accumulator = Buffer.alloc(0);
  let currentTimestamp = 0;

  for (const notif of notifications) {
    // Check if this starts a new frame (SOF = 0xAA)
    if (notif.value.length > 0 && notif.value[0] === SOF) {
      // Process any accumulated data first
      if (accumulator.length > 0) {
        const parsed = tryParseWhoopPayload(accumulator, currentTimestamp);
        if (parsed) packets.push(parsed);
      }
      accumulator = Buffer.from(notif.value);
      currentTimestamp = notif.timestamp;
    } else {
      // Continuation chunk — append
      accumulator = Buffer.concat([accumulator, notif.value]);
    }
  }

  // Don't forget the last accumulated frame
  if (accumulator.length > 0) {
    const parsed = tryParseWhoopPayload(accumulator, currentTimestamp);
    if (parsed) packets.push(parsed);
  }

  return packets;
}

function tryParseWhoopPayload(frame: Buffer, timestamp: number): WhoopPacket | null {
  // Frame: [0xAA] [payloadLen: u16 LE] [crc8: u8] [payload...] [crc32: u32]
  if (frame.length < 8) return null; // minimum: SOF(1) + len(2) + crc8(1) + type(1) + crc32(4)
  if (frame[0] !== SOF) return null;

  const payloadLen = frame.readUInt16LE(1);
  const headerSize = 4; // SOF + len(2) + crc8(1)
  const expectedTotal = headerSize + payloadLen + 4; // +4 for trailing CRC32

  // Allow slightly short frames (BLE fragmentation edge cases)
  if (frame.length < headerSize + Math.min(payloadLen, 13)) return null;

  const payload = frame.subarray(headerSize, headerSize + payloadLen);
  if (payload.length < 1) return null;

  const packetType = payload[0];
  const packetTypeName = PacketTypeName[packetType] ?? `UNKNOWN(0x${packetType.toString(16)})`;

  let recordType = 0;
  let dataTimestamp = 0;
  let subSeconds = 0;

  // Data packets have the standard header (13+ bytes)
  if (payload.length >= 13) {
    recordType = payload[1];
    dataTimestamp = payload.readUInt32LE(3);
    subSeconds = payload.readUInt16LE(11);
  }

  return {
    timestamp,
    packetType,
    packetTypeName,
    recordType,
    dataTimestamp,
    subSeconds,
    payload: Buffer.from(payload),
  };
}

// ---------------------------------------------------------------------------
// IMU data extraction
// ---------------------------------------------------------------------------

interface ImuSample {
  timestamp: number;
  ax: number;
  ay: number;
  az: number;
  /** second set — could be gyro or optical, TBD */
  bx: number;
  by: number;
  bz: number;
}

function extractImuSamples(packet: WhoopPacket): ImuSample[] {
  const p = packet.payload;
  const samples: ImuSample[] = [];

  // IMU stream packet (type 0x33 or 0x34)
  // Offset 24: sampleCountA (u16), offset 26: sampleCountB (u16)
  // Offset 28+: interleaved i16 arrays
  if (
    (packet.packetType === PacketType.REALTIME_IMU ||
      packet.packetType === PacketType.HISTORICAL_IMU) &&
    p.length >= 28
  ) {
    const countA = p.readUInt16LE(24);
    const countB = p.readUInt16LE(26);
    const count = Math.min(countA, countB, 200); // safety cap
    let offset = 28;

    for (let i = 0; i < count && offset + 12 <= p.length; i++) {
      samples.push({
        timestamp: packet.dataTimestamp,
        ax: p.readInt16LE(offset),
        ay: p.readInt16LE(offset + 2),
        az: p.readInt16LE(offset + 4),
        bx: p.readInt16LE(offset + 6),
        by: p.readInt16LE(offset + 8),
        bz: p.readInt16LE(offset + 10),
      });
      offset += 12;
    }
  }

  // R21 Maverick raw packet (record type 21, packet type 0x2B)
  // 1244 bytes, 6 channels of i16 at fixed offsets
  if (
    packet.packetType === PacketType.REALTIME_RAW_DATA &&
    packet.recordType === 21 &&
    p.length >= 1244
  ) {
    const countA = p.readUInt16LE(16);
    const countB = p.readUInt16LE(622);
    const count = Math.min(countA, 100);

    for (let i = 0; i < count; i++) {
      samples.push({
        timestamp: packet.dataTimestamp,
        ax: p.readInt16LE(20 + i * 2),
        ay: p.readInt16LE(220 + i * 2),
        az: p.readInt16LE(420 + i * 2),
        bx: i < countB ? p.readInt16LE(632 + i * 2) : 0,
        by: i < countB ? p.readInt16LE(832 + i * 2) : 0,
        bz: i < countB ? p.readInt16LE(1032 + i * 2) : 0,
      });
    }
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  const showRaw = args.includes("--raw");
  const file = args.find((a) => !a.startsWith("--"));

  if (!file) {
    console.log("Usage: npx tsx scripts/parse-whoop-ble-capture.ts <capture-file> [--raw]");
    console.log("");
    console.log("Supported formats: .btsnoop, .pklg, .log");
    console.log("  --raw   Show all packet hex dumps");
    process.exit(1);
  }

  console.log(`Reading ${file}...`);
  const buf = readFileSync(file);
  console.log(`File size: ${buf.length} bytes`);

  // Detect format
  let hciPackets: HciPacket[];
  const magic = buf.toString("ascii", 0, 8);
  if (magic === "btsnoop\0") {
    console.log("Format: btsnoop");
    hciPackets = parseBtsnoop(buf);
  } else {
    console.log("Format: pklg (Apple PacketLogger)");
    hciPackets = parsePklg(buf);
  }
  console.log(`HCI packets: ${hciPackets.length}`);

  // Extract ATT layer
  const { notifications, writes } = extractAttFromAcl(hciPackets);
  console.log(`ATT notifications: ${notifications.length}, writes: ${writes.length}`);

  // Show commands written (to understand the sync flow)
  console.log("\n=== Commands Written (ATT writes) ===\n");
  for (const w of writes) {
    const hex = w.value.toString("hex");
    // Try to identify Whoop command packets
    if (w.value.length >= 3 && w.value[0] === SOF) {
      // This is a framed command
      console.log(`  handle=0x${w.handle.toString(16)} FRAME: ${hex}`);
    } else if (w.value[0] === PacketType.COMMAND || w.value[0] === PacketType.PUFFIN_COMMAND) {
      const cmdByte = w.value.length >= 3 ? w.value[2] : 0;
      const cmdName = CommandName[cmdByte] ?? `0x${cmdByte.toString(16)}`;
      console.log(`  handle=0x${w.handle.toString(16)} CMD: ${cmdName} (${hex})`);
    } else {
      console.log(`  handle=0x${w.handle.toString(16)} raw: ${hex}`);
    }
  }

  // Parse Whoop frames from notifications
  console.log("\n=== Whoop Data Packets ===\n");
  const whoopPackets = parseWhoopFrames(notifications);
  console.log(`Parsed ${whoopPackets.length} Whoop packets`);

  // Summarize by type
  const typeCounts: Record<string, number> = {};
  for (const pkt of whoopPackets) {
    const key = `${pkt.packetTypeName} (R${pkt.recordType})`;
    typeCounts[key] = (typeCounts[key] ?? 0) + 1;
  }
  console.log("\nPacket type breakdown:");
  for (const [type, count] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${type}: ${count}`);
  }

  // Extract IMU samples
  const allImuSamples: ImuSample[] = [];
  for (const pkt of whoopPackets) {
    allImuSamples.push(...extractImuSamples(pkt));
  }

  if (allImuSamples.length > 0) {
    console.log(`\n=== IMU/Accelerometer Samples: ${allImuSamples.length} ===\n`);
    console.log("timestamp,ax,ay,az,bx,by,bz");
    for (const s of allImuSamples.slice(0, 20)) {
      console.log(`${s.timestamp},${s.ax},${s.ay},${s.az},${s.bx},${s.by},${s.bz}`);
    }
    if (allImuSamples.length > 20) {
      console.log(`... (${allImuSamples.length - 20} more samples)`);
    }

    // Write full CSV
    const csvFile = file.replace(/\.[^.]+$/, "") + "-imu.csv";
    const csvLines = [
      "timestamp,ax,ay,az,bx,by,bz",
      ...allImuSamples.map((s) => `${s.timestamp},${s.ax},${s.ay},${s.az},${s.bx},${s.by},${s.bz}`),
    ];
    writeFileSync(csvFile, csvLines.join("\n"));
    console.log(`\nFull CSV written to: ${csvFile}`);
  } else {
    console.log("\nNo IMU/accelerometer packets found in this capture.");
    console.log(
      "This is expected if the Whoop app only performed a normal sync (HR + recovery data).",
    );
    console.log(
      "IMU packets (0x33/0x34) require the strap to be in IMU mode or strength training mode.",
    );
  }

  // Show raw hex dumps if requested
  if (showRaw) {
    console.log("\n=== Raw Packet Dumps ===\n");
    for (const pkt of whoopPackets.slice(0, 50)) {
      const ts = new Date(pkt.dataTimestamp * 1000).toISOString();
      console.log(
        `[${pkt.packetTypeName}] R${pkt.recordType} ts=${ts} (${pkt.payload.length} bytes)`,
      );
      console.log(`  ${pkt.payload.toString("hex").slice(0, 200)}`);
    }
    if (whoopPackets.length > 50) {
      console.log(`... (${whoopPackets.length - 50} more packets)`);
    }
  }

  // Summary of what historical data was found
  const historicalPackets = whoopPackets.filter((p) => p.packetType === PacketType.HISTORICAL_DATA);
  if (historicalPackets.length > 0) {
    const timestamps = historicalPackets.map((p) => p.dataTimestamp);
    const minTs = Math.min(...timestamps);
    const maxTs = Math.max(...timestamps);
    console.log(`\n=== Historical Data Range ===`);
    console.log(`  Earliest: ${new Date(minTs * 1000).toISOString()}`);
    console.log(`  Latest:   ${new Date(maxTs * 1000).toISOString()}`);
    console.log(`  Packets:  ${historicalPackets.length}`);

    // Break down record types within historical data
    const recordTypes: Record<number, number> = {};
    for (const pkt of historicalPackets) {
      recordTypes[pkt.recordType] = (recordTypes[pkt.recordType] ?? 0) + 1;
    }
    console.log("  Record types:");
    for (const [rt, count] of Object.entries(recordTypes).sort(
      (a, b) => Number(b[0]) - Number(a[0]),
    )) {
      console.log(`    R${rt}: ${count} packets`);
    }
  }

  console.log("\nDone!");
}

main();
