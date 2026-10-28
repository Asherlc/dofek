import { recordTestFlightUpload, requiresTestFlightUpload } from "./testflight-deployment.ts";

const [command, repository, commitSha, buildNumber, runUrl, ...extra] = process.argv.slice(2);
if (
  command === "detect" &&
  repository &&
  commitSha &&
  (buildNumber === undefined || buildNumber === "--force") &&
  runUrl === undefined
) {
  console.log(requiresTestFlightUpload(repository, commitSha, buildNumber === "--force"));
} else if (
  command === "record" &&
  repository &&
  commitSha &&
  buildNumber &&
  runUrl &&
  !extra.length
) {
  recordTestFlightUpload(repository, commitSha, buildNumber, runUrl);
} else {
  throw new Error(
    "Usage: pnpm tsx scripts/testflight-deployment-cli.ts detect <owner/repo> <full-sha> [--force] | record <owner/repo> <full-sha> <build-number> <run-url>",
  );
}
