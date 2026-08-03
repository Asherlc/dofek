import { pathToFileURL } from "node:url";
import { renderDeployServiceEnvironmentFiles } from "./deploy-service-environment.ts";

function main(): void {
  const sourcePath = process.argv[2];
  const outputDirectory = process.argv[3];
  if (!sourcePath || !outputDirectory || process.argv.length !== 4) {
    throw new Error(
      "Usage: render-deploy-service-env.ts <rendered-dotenv-path> <output-directory>",
    );
  }

  const paths = renderDeployServiceEnvironmentFiles(sourcePath, outputDirectory);
  for (const [serviceName, path] of Object.entries(paths)) {
    console.log(`Rendered ${serviceName} deploy environment: ${path}`);
  }
}

const commandPath = process.argv[1];
if (commandPath && import.meta.url === pathToFileURL(commandPath).href) {
  main();
}
