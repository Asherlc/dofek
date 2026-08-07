import { createRequire } from "node:module";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runZeusCli } from "../src/zeus-cli.ts";

process.chdir(dirname(fileURLToPath(import.meta.url)));
runZeusCli(createRequire(new URL("../package.json", import.meta.url)));
