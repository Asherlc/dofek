import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const packageDirectory = realpathSync("packages/mobile/modules/health-kit");
const minimumCoverage = 90;
const sources = ["ios/HealthKitQueries.swift", "ios/HealthKitTypes.swift"];

console.log("Running Swift tests with coverage...");
execFileSync("swift", ["test", "--enable-code-coverage"], {
  cwd: packageDirectory,
  stdio: "inherit",
});
const reportPath = execFileSync("swift", ["test", "--show-codecov-path"], {
  cwd: packageDirectory,
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
}).trim();

const report = z
  .object({
    data: z.array(
      z.object({
        files: z.array(z.object({ filename: z.string(), summary: z.unknown() })),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(reportPath, "utf8")));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `coverage-directory=${dirname(reportPath)}\n`);
}

const metricSchema = z
  .object({
    count: z.number().int().positive(),
    covered: z.number().int().nonnegative(),
  })
  .refine((metric) => metric.covered <= metric.count);
const summarySchema = z.object({ lines: metricSchema, functions: metricSchema });
const files = report.data.flatMap((data) => data.files);
const summaries = sources.map((source) => {
  const sourcePath = join(packageDirectory, source);
  const file = files.find((candidate) => candidate.filename === sourcePath);
  if (!file) throw new Error(`Coverage report is missing ${source}`);
  return summarySchema.parse(file.summary);
});

for (const [metric, label] of [
  ["lines", "Line"],
  ["functions", "Function"],
] as const) {
  const total = summaries.reduce((sum, summary) => sum + summary[metric].count, 0);
  const covered = summaries.reduce((sum, summary) => sum + summary[metric].covered, 0);
  const percent = (covered / total) * 100;
  console.log(`${label} coverage: ${percent.toFixed(2)}% (minimum: ${minimumCoverage}%)`);
  if (percent < minimumCoverage) throw new Error(`${label} coverage is below ${minimumCoverage}%`);
}

console.log("PASS: All coverage thresholds met.");
