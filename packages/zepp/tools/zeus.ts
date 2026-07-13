import { createRequire } from "node:module";

import { runZeusCli } from "../src/zeus-cli.ts";

runZeusCli(createRequire(import.meta.url));
