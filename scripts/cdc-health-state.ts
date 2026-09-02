import { z } from "zod";
import { CdcHealthStateFile } from "../src/lib/cdc-health-state.ts";

const actionSchema = z.enum(["initialize", "failure", "probe", "success"]);
const stateFilePath =
  process.env.CDC_HEALTH_STATE_FILE?.trim() || "/tmp/dofek-cdc-health-state.json";
const rawIntervalSeconds = process.env.CDC_HEALTH_INTERVAL_SECONDS ?? "300";

if (!/^\d+$/.test(rawIntervalSeconds)) {
  throw new Error("CDC_HEALTH_INTERVAL_SECONDS must be a positive integer");
}

const intervalSeconds = Number.parseInt(rawIntervalSeconds, 10);
if (intervalSeconds <= 0) {
  throw new Error("CDC_HEALTH_INTERVAL_SECONDS must be a positive integer");
}

const stateFile = new CdcHealthStateFile({
  filePath: stateFilePath,
  intervalSeconds,
});

switch (actionSchema.parse(process.argv[2])) {
  case "initialize":
    stateFile.initialize();
    break;
  case "failure":
    stateFile.recordFailure();
    break;
  case "probe":
    stateFile.assertHealthy();
    break;
  case "success":
    stateFile.recordSuccess();
    break;
}
