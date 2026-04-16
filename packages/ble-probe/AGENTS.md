# BLE Probe Agent Guide

> Read [README.md](./README.md) first for general architecture and usage.

## WHOOP BLE Protocol
WHOOP uses a custom framed protocol over BLE.
- **SOF**: `0xAA` (Start of Frame)
- **Version**: `0x01`
- **Length**: 2 bytes (LE)
- **Payload**: Preamble (`0x0001E741`) + Packet Type + Sequence + Data

### Packet Types
- `0x23`: COMMAND
- `0x24`: CMD_RESPONSE
- `0x28`: REALTIME_DATA
- `0x2B`: REALTIME_RAW (unfiltered heart rate/IMU)
- `0x2F`: HISTORICAL (off-wrist/backlog)

### Essential Commands
- `0x91`: `GET_HELLO` - Initial handshake.
- `0x6a`: `TOGGLE_IMU_MODE` - Activates high-frequency IMU streaming (accelerometer/gyro).
- `0x51`: `START_RAW_DATA` - Activates raw PPG data streaming.

## Tool Implementation
The probe uses a background thread for the REPL to keep the main thread free for the CoreBluetooth run loop. Use the `stats` command to see the distribution of packet types being received.
