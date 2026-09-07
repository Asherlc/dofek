import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { decodeBin } from "../../../src/providers/zos-app/decode.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { output: { type: "string", short: "o" } },
});
const [inputPath] = positionals;
if (!inputPath || positionals.length !== 1) {
  throw new Error("Usage: pnpm tsx tools/decode-imu.ts <session.bin> [-o samples.csv]");
}

const raw = readFileSync(inputPath);
const { samples, ...header } = decodeBin(
  raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
);
console.log(JSON.stringify({ ...header, decodedVectors: samples.length }, null, 2));

if (values.output) {
  const rows = samples.map((sample) =>
    [sample.tMs, header.sessionStartMs + sample.tMs, sample.sensor, sample.x, sample.y, sample.z].join(","),
  );
  writeFileSync(values.output, ["t_ms,timestamp_ms,sensor,x,y,z", ...rows, ""].join("\n"));
  console.log(`Wrote ${values.output}`);
}
