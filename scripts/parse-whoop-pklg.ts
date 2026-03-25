/**
 * Parse a .pklg (PacketLogger) file and extract Whoop BLE GATT traffic.
 *
 * PKLG format: sequence of records, each:
 *   - 4 bytes: record length (little-endian, includes the 4 length bytes)
 *   - 8 bytes: timestamp (seconds + microseconds as two 32-bit BE values)
 *   - 1 byte: packet type (0x00 = HCI Command, 0x01 = HCI ACL Tx, 0x02 = HCI ACL Rx, 0xFC = text/info)
 *   - N bytes: payload
 *
 * We're looking for HCI ACL packets that contain ATT protocol data,
 * specifically targeting Whoop's custom BLE service UUIDs.
 */

import { readFileSync } from "node:fs";

const file = process.argv[2] || `${process.env.HOME}/Downloads/whoop-capture.pklg`;
const buf = readFileSync(file);

// Known Whoop BLE UUIDs (from APK decompilation)
const WHOOP_SERVICE_UUIDS = [
  "61080001-8d6d-82b8-614a-1c8cb0f8dcc6", // Gen4
  "fd4b0001-1e62-4c98-8561-8818030e0000", // Maverick/Goose
];

// Track all unique ATT handles and their UUIDs
const handleToUuid = new Map<number, string>();
const _handleToData = new Map<number, Buffer[]>();

// Stats
let totalRecords = 0;
let aclPackets = 0;
let attPackets = 0;
const _whoopPackets = 0;
const infoMessages: string[] = [];

// Parse UUID from bytes (little-endian 128-bit)
function parseUuid128(data: Buffer, offset: number): string {
  const bytes = [];
  for (let i = 15; i >= 0; i--) {
    bytes.push(data[offset + i].toString(16).padStart(2, "0"));
  }
  return `${bytes.slice(0, 4).join("")}-${bytes.slice(4, 6).join("")}-${bytes.slice(6, 8).join("")}-${bytes.slice(8, 10).join("")}-${bytes.slice(10, 16).join("")}`;
}

function parseUuid16(data: Buffer, offset: number): string {
  return `0000${data.readUInt16LE(offset).toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
}

// ATT opcodes we care about
const ATT_OPCODES: Record<number, string> = {
  1: "ERROR_RSP",
  2: "EXCHANGE_MTU_REQ",
  3: "EXCHANGE_MTU_RSP",
  4: "FIND_INFO_REQ",
  5: "FIND_INFO_RSP",
  6: "FIND_BY_TYPE_REQ",
  7: "FIND_BY_TYPE_RSP",
  8: "READ_BY_TYPE_REQ",
  9: "READ_BY_TYPE_RSP",
  10: "READ_REQ",
  11: "READ_RSP",
  12: "READ_BLOB_REQ",
  13: "READ_BLOB_RSP",
  16: "READ_BY_GROUP_REQ",
  17: "READ_BY_GROUP_RSP",
  18: "WRITE_REQ",
  19: "WRITE_RSP",
  22: "PREPARE_WRITE_REQ",
  23: "PREPARE_WRITE_RSP",
  27: "HANDLE_VALUE_NTF",
  29: "HANDLE_VALUE_IND",
  30: "HANDLE_VALUE_CFM",
  82: "WRITE_CMD",
};

interface AttEvent {
  timestamp: number;
  direction: "tx" | "rx";
  opcode: number;
  opcodeName: string;
  handle?: number;
  data: Buffer;
  raw: Buffer;
}

const attEvents: AttEvent[] = [];

let offset = 0;
while (offset < buf.length - 4) {
  const recordLen = buf.readUInt32LE(offset);
  if (recordLen < 13 || offset + recordLen > buf.length) {
    // Try to skip bad records
    offset += 4;
    continue;
  }

  const timestampSec = buf.readUInt32LE(offset + 4);
  const timestampUsec = buf.readUInt32LE(offset + 8);
  const timestamp = timestampSec + timestampUsec / 1_000_000;
  const packetType = buf[offset + 12];

  const payloadStart = offset + 13;
  const payloadLen = recordLen - 13;
  const payload = buf.subarray(payloadStart, payloadStart + payloadLen);

  totalRecords++;

  if (packetType === 0xfc && payloadLen > 0) {
    // Info/text record
    const text = payload.toString("utf8").replace(/\0/g, "");
    if (text.length > 0) {
      infoMessages.push(text);
    }
  }

  // HCI ACL Data (0x01 = Tx from host, 0x02 = Rx to host, sometimes 0x00/0x01)
  // In pklg format: type 0x00 = HCI command, 0x01 = ACL Tx, 0x02 = ACL Rx
  if ((packetType === 0x01 || packetType === 0x02 || packetType === 0x00) && payloadLen >= 4) {
    aclPackets++;

    // HCI ACL header: 2 bytes handle+flags, 2 bytes data length
    const _hciHandle = payload.readUInt16LE(0) & 0x0fff;
    const _pbFlag = (payload.readUInt16LE(0) >> 12) & 0x03;
    const hciDataLen = payload.readUInt16LE(2);

    if (hciDataLen > 0 && payloadLen >= 4 + 4) {
      // L2CAP header: 2 bytes length, 2 bytes CID
      const _l2capLen = payload.readUInt16LE(4);
      const l2capCid = payload.readUInt16LE(6);

      // CID 0x0004 = ATT protocol
      if (l2capCid === 0x0004 && payloadLen >= 9) {
        attPackets++;
        const attOpcode = payload[8];
        const attData = payload.subarray(9);
        const direction = packetType === 0x01 ? "tx" : "rx";

        const event: AttEvent = {
          timestamp,
          direction,
          opcode: attOpcode,
          opcodeName: ATT_OPCODES[attOpcode] || `UNKNOWN_0x${attOpcode.toString(16)}`,
          data: Buffer.from(attData),
          raw: Buffer.from(payload.subarray(8)),
        };

        // Extract handle from relevant opcodes
        if (
          attData.length >= 2 &&
          [0x09, 0x0b, 0x0d, 0x12, 0x13, 0x1b, 0x1d, 0x52, 0x0a, 0x0c].includes(attOpcode)
        ) {
          event.handle = attData.readUInt16LE(0);
        }

        // Parse Read By Group Response (service discovery)
        if (attOpcode === 0x11 && attData.length >= 1) {
          const attrLen = attData[0];
          let i = 1;
          while (i + attrLen <= attData.length) {
            const startHandle = attData.readUInt16LE(i);
            const _endHandle = attData.readUInt16LE(i + 2);
            let uuid: string;
            if (attrLen === 6) {
              uuid = parseUuid16(attData, i + 4);
            } else if (attrLen === 20) {
              uuid = parseUuid128(attData, i + 4);
            } else {
              uuid = `unknown(len=${attrLen})`;
            }
            handleToUuid.set(startHandle, uuid);
            i += attrLen;
          }
        }

        // Parse Read By Type Response (characteristic discovery)
        if (attOpcode === 0x09 && attData.length >= 1) {
          const attrLen = attData[0];
          let i = 1;
          while (i + attrLen <= attData.length) {
            const _attrHandle = attData.readUInt16LE(i);
            if (attrLen >= 7) {
              const valHandle = attData.readUInt16LE(i + 3);
              let uuid: string;
              if (attrLen === 7) {
                uuid = parseUuid16(attData, i + 5);
              } else if (attrLen === 21) {
                uuid = parseUuid128(attData, i + 5);
              } else {
                uuid = `unknown(len=${attrLen})`;
              }
              handleToUuid.set(valHandle, uuid);
            }
            i += attrLen;
          }
        }

        // Parse Find Information Response (descriptor discovery)
        if (attOpcode === 0x05 && attData.length >= 1) {
          const format = attData[0];
          let i = 1;
          const entryLen = format === 1 ? 4 : 18;
          while (i + entryLen <= attData.length) {
            const descriptorHandle = attData.readUInt16LE(i);
            const uuid = format === 1 ? parseUuid16(attData, i + 2) : parseUuid128(attData, i + 2);
            handleToUuid.set(descriptorHandle, uuid);
            i += entryLen;
          }
        }

        attEvents.push(event);
      }
    }
  }

  offset += recordLen;
}

// Print summary
console.log("=== PKLG Parse Summary ===");
console.log(`File: ${file}`);
console.log(`Size: ${buf.length} bytes`);
console.log(`Total records: ${totalRecords}`);
console.log(`ACL packets: ${aclPackets}`);
console.log(`ATT packets: ${attPackets}`);
console.log();

// Print info messages (device info)
console.log("=== Device Info ===");
for (const msg of infoMessages.slice(0, 10)) {
  console.log(`  ${msg}`);
}
console.log();

// Print discovered services/characteristics
console.log("=== Discovered BLE Handles ===");
const sortedHandles = [...handleToUuid.entries()].sort((a, b) => a[0] - b[0]);
for (const [handle, uuid] of sortedHandles) {
  const isWhoop = WHOOP_SERVICE_UUIDS.some(
    (wu) => uuid.startsWith(wu.slice(0, 8)), // Match service family
  );
  const marker = isWhoop ? " <<<< WHOOP" : "";
  console.log(`  Handle 0x${handle.toString(16).padStart(4, "0")}: ${uuid}${marker}`);
}
console.log();

// Find Whoop-related handles
const whoopHandles = new Set<number>();
for (const [handle, uuid] of handleToUuid) {
  if (
    WHOOP_SERVICE_UUIDS.some(
      (wu) =>
        uuid.startsWith(wu.slice(0, 8)) || uuid.startsWith("61080") || uuid.startsWith("fd4b0"),
    )
  ) {
    whoopHandles.add(handle);
  }
}

// Print ATT traffic summary by handle
console.log("=== ATT Traffic by Handle ===");
const handleTraffic = new Map<
  number,
  { tx: number; rx: number; notifications: number; totalBytes: number }
>();
for (const evt of attEvents) {
  if (evt.handle !== undefined) {
    const stats = handleTraffic.get(evt.handle) || {
      tx: 0,
      rx: 0,
      notifications: 0,
      totalBytes: 0,
    };
    if (evt.direction === "tx") stats.tx++;
    else stats.rx++;
    if (evt.opcode === 0x1b) stats.notifications++;
    stats.totalBytes += evt.data.length;
    handleTraffic.set(evt.handle, stats);
  }
}

const sortedTraffic = [...handleTraffic.entries()].sort(
  (a, b) => b[1].totalBytes - a[1].totalBytes,
);
for (const [handle, stats] of sortedTraffic.slice(0, 30)) {
  const uuid = handleToUuid.get(handle) || "unknown";
  const isWhoop = whoopHandles.has(handle);
  const marker = isWhoop ? " <<<< WHOOP" : "";
  console.log(
    `  Handle 0x${handle.toString(16).padStart(4, "0")} (${uuid.slice(0, 13)}...): tx=${stats.tx} rx=${stats.rx} ntf=${stats.notifications} bytes=${stats.totalBytes}${marker}`,
  );
}
console.log();

// Print notifications (likely data streaming)
console.log("=== Notification Streams (Handle Value Notifications) ===");
const notificationHandleStats: Record<
  number,
  { count: number; totalBytes: number; firstBytes: string[] }
> = {};
for (const evt of attEvents.filter((e) => e.opcode === 0x1b)) {
  const handle = evt.handle ?? 0;
  if (!notificationHandleStats[handle])
    notificationHandleStats[handle] = { count: 0, totalBytes: 0, firstBytes: [] };
  notificationHandleStats[handle].count++;
  notificationHandleStats[handle].totalBytes += evt.data.length;
  if (notificationHandleStats[handle].firstBytes.length < 3) {
    notificationHandleStats[handle].firstBytes.push(
      evt.data.subarray(0, Math.min(20, evt.data.length)).toString("hex"),
    );
  }
}

for (const [handleStr, info] of Object.entries(notificationHandleStats)) {
  const handle = Number(handleStr);
  const uuid = handleToUuid.get(handle) || "unknown";
  console.log(
    `  Handle 0x${handle.toString(16).padStart(4, "0")} (${uuid.slice(0, 20)}...): ${info.count} notifications, ${info.totalBytes} bytes total`,
  );
  for (const hex of info.firstBytes) {
    console.log(`    First bytes: ${hex}`);
  }
}
console.log();

// Print writes to device (commands sent)
console.log("=== Writes to Device (Commands Sent) ===");
const writes = attEvents.filter((e) => e.opcode === 0x12 || e.opcode === 0x52);
for (const w of writes.slice(0, 30)) {
  const handle = w.handle !== undefined ? `0x${w.handle.toString(16).padStart(4, "0")}` : "???";
  const uuid = w.handle !== undefined ? handleToUuid.get(w.handle) || "unknown" : "unknown";
  const hex = w.data.subarray(2, Math.min(22, w.data.length)).toString("hex");
  console.log(`  ${w.opcodeName} to ${handle} (${uuid.slice(0, 20)}...): ${hex}`);
}
console.log();

// Dump all Whoop-handle data if found
if (whoopHandles.size > 0) {
  console.log("=== Whoop Handle Data ===");
  const whoopEvents = attEvents.filter((e) => e.handle !== undefined && whoopHandles.has(e.handle));
  for (const evt of whoopEvents.slice(0, 50)) {
    const handle = `0x${(evt.handle ?? 0).toString(16).padStart(4, "0")}`;
    console.log(
      `  [${evt.direction}] ${evt.opcodeName} handle=${handle}: ${evt.data.subarray(0, Math.min(40, evt.data.length)).toString("hex")}`,
    );
  }
} else {
  console.log("No Whoop-specific handles found in service discovery.");
  console.log("The capture may not include the connection setup phase.");
  console.log(
    "Try: disconnect Whoop app, start capture, then open Whoop app to force reconnection.",
  );
}
