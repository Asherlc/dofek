import {
  prepareTestFlightUpload,
  recordTestFlightUpload,
  requiresTestFlightUpload,
} from "./testflight-deployment.ts";

const [command, repository, first, second, third, fourth, ...extra] = process.argv.slice(2);
if (
  command === "detect" &&
  repository &&
  first &&
  (second === undefined || second === "--force") &&
  third === undefined
) {
  console.log(requiresTestFlightUpload(repository, first, second === "--force"));
} else if (
  command === "prepare" &&
  repository &&
  first &&
  second &&
  third &&
  fourth === undefined
) {
  console.log(prepareTestFlightUpload(repository, first, second, third));
} else if (
  command === "record" &&
  repository &&
  first &&
  /^[1-9]\d*$/.test(first) &&
  second &&
  third &&
  fourth &&
  !extra.length
) {
  recordTestFlightUpload(repository, Number(first), second, third, fourth);
} else {
  throw new Error(
    "Usage: pnpm tsx scripts/testflight-deployment-cli.ts detect <owner/repo> <full-sha> [--force] | prepare <owner/repo> <full-sha> <build-number> <upload-run-url> | record <owner/repo> <deployment-id> <full-sha> <build-number> <upload-run-url>",
  );
}
