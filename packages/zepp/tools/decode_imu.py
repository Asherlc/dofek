import struct
from pathlib import Path

import pandas as pd

MAGIC = 0x314D5549
HEADER_SIZE = 32
FLAG_HAS_GYRO = 1


def _read_header(data: bytes):
    if len(data) < HEADER_SIZE:
        raise ValueError("file too small for header")

    magic, version, flags, _, ss_low, ss_high, sample_count, accel_mode, gyro_mode, observed_hz_x100 = struct.unpack_from(
        "<IBBHIIIBBH", data, 0
    )

    if magic != MAGIC:
        raise ValueError(f"bad magic: {magic:#x}")

    return {
        "version": version,
        "has_gyro": bool(flags & FLAG_HAS_GYRO),
        "session_start_ms": (ss_high << 32) | ss_low,
        "sample_count": sample_count,
        "accel_freq_mode": accel_mode,
        "gyro_freq_mode": gyro_mode,
        "observed_hz": observed_hz_x100 / 100.0,
    }


def decode_imu_file(path: str | Path) -> pd.DataFrame:
    raw = Path(path).read_bytes()
    meta = _read_header(raw)

    rows = []
    offset = HEADER_SIZE
    record_size = 28 if meta["has_gyro"] else 16

    while offset + 4 <= len(raw):
        chunk_count = struct.unpack_from("<H", raw, offset)[0]
        offset += 4

        for _ in range(chunk_count):
            if offset + record_size > len(raw):
                break

            t_ms, ax, ay, az = struct.unpack_from("<Ifff", raw, offset)
            offset += 16

            row = {
                "t_ms": t_ms,
                "ax": ax,
                "ay": ay,
                "az": az,
            }

            if meta["has_gyro"]:
                gx, gy, gz = struct.unpack_from("<fff", raw, offset)
                offset += 12
                row.update({"gx": gx, "gy": gy, "gz": gz})

            rows.append(row)

    df = pd.DataFrame(rows)
    df.attrs["header"] = meta
    return df


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Decode IMU Logger binary export")
    parser.add_argument("file", help="Path to imu_*.bin exported from the phone")
    parser.add_argument(
        "-o",
        "--output",
        help="Optional CSV output path (defaults to stdout summary only)",
    )
    args = parser.parse_args()

    frame = decode_imu_file(args.file)
    header = frame.attrs["header"]

    print("Header:")
    for key, value in header.items():
        print(f"  {key}: {value}")

    print(f"Decoded rows: {len(frame)}")
    if len(frame):
        duration_s = frame["t_ms"].iloc[-1] / 1000.0
        measured = len(frame) / duration_s if duration_s > 0 else 0.0
        print(f"Derived rate from timestamps: {measured:.2f} Hz")
        print(frame.head())

    if args.output:
        frame.to_csv(args.output, index=False)
        print(f"Wrote {args.output}")
