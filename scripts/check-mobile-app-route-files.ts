import { readdirSync } from "node:fs";
import path from "node:path";

const appDirectory = path.resolve("packages/mobile/app");
const forbiddenRouteFilePatterns = [
  /\.(test|stories)\./,
  /(^|[._-])fixtures?([._-]|$)/i,
  /(^|[._-])helpers?([._-]|$)/i,
];

function findForbiddenFiles(directory: string): string[] {
  const entries = readdirSync(directory, { withFileTypes: true });
  const forbiddenFiles: string[] = [];

  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      forbiddenFiles.push(...findForbiddenFiles(absolutePath));
      continue;
    }

    if (entry.isFile() && forbiddenRouteFilePatterns.some((pattern) => pattern.test(entry.name))) {
      forbiddenFiles.push(path.relative(process.cwd(), absolutePath));
    }
  }

  return forbiddenFiles.sort();
}

const forbiddenFiles = findForbiddenFiles(appDirectory);

if (forbiddenFiles.length > 0) {
  console.error("Expo Router app directory contains non-route files:");
  for (const file of forbiddenFiles) {
    console.error(`- ${file}`);
  }
  console.error("");
  console.error(
    "Move route tests to packages/mobile/app-tests/, route stories to packages/mobile/app-stories/, and shared fixtures to packages/mobile/app-fixtures/.",
  );
  process.exit(1);
}
