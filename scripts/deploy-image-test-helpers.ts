import {
  execFileSync,
  type SpawnSyncOptionsWithStringEncoding,
  spawnSync,
} from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const deployTestRepository = "ghcr.io/asherlc/dofek";
export const deployTestDigest = `sha256:${"a".repeat(64)}`;
export const deployTestOldImage = `${deployTestRepository}:previous@sha256:${"b".repeat(64)}`;

export function runDeployImageFixture({
  script,
  args = [],
  desiredImage = deployTestOldImage,
  digest = deployTestDigest,
  release = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  failure = "",
  filename = "resolve-deploy-image.ts",
  taskImages = [deployTestOldImage],
  taskState = "running",
  desiredReplicas = 1,
  environment = {},
}: {
  script?: string;
  args?: string[];
  desiredImage?: string;
  digest?: unknown;
  release?: string;
  failure?: string;
  filename?: string;
  taskImages?: string[];
  taskState?: string;
  desiredReplicas?: number | string;
  environment?: Record<string, string>;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "deploy-image-"));
  const outputPath = join(directory, "output");
  const callsPath = join(directory, "calls");
  writeFileSync(outputPath, "");
  writeFileSync(callsPath, "");
  const dotenvPath = join(directory, "deploy.env");
  writeFileSync(dotenvPath, "APP_IMAGE=wrong:mutable\nWEB_ENV_FILE=wrong.env\n");
  const dockerPath = join(directory, "docker");
  writeFileSync(
    dockerPath,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');",
      "const command = args.slice(0, 2).join(' ');",
      "if (process.env.FIXTURE_FAILURE && command === process.env.FIXTURE_FAILURE) { console.error('Docker unavailable'); process.exit(1); }",
      "if (command === 'buildx imagetools') {",
      "  fs.writeFileSync(process.env.FIXTURE_MOVED, 'moved');",
      "  console.log(JSON.stringify({digest: JSON.parse(process.env.FIXTURE_DIGEST)}));",
      "} else if (args[0] === 'pull') { console.log('pulled ' + args[1]);",
      "} else if (command === 'image inspect') {",
      "  const pinned = args[2].endsWith('@' + process.env.FIXTURE_PINNED_DIGEST);",
      "  const release = pinned || !fs.existsSync(process.env.FIXTURE_MOVED) ? process.env.FIXTURE_RELEASE : 'wrong-release-after-tag-move';",
      "  console.log(args.includes('{{json .Config.Env}}') ? JSON.stringify(['SENTRY_RELEASE=' + release]) : 'SENTRY_RELEASE=' + release);",
      "} else if (command === 'service ls') { console.log(process.env.FIXTURE_DESIRED ? 'dofek_web' : '');",
      "} else if (command === 'service inspect') { console.log(args.includes('{{.Spec.Mode.Replicated.Replicas}}') ? process.env.FIXTURE_REPLICAS : process.env.FIXTURE_DESIRED);",
      "} else if (command === 'service ps') { console.log(JSON.parse(process.env.FIXTURE_TASK_IMAGES).map((_, i) => 'task' + i).join('\\n'));",
      "} else if (command === 'inspect --type') {",
      "  if (args[5] !== '{\"image\":{{json .Spec.ContainerSpec.Image}},\"state\":{{json .Status.State}}}') { console.error('Task inspection must request only image and state'); process.exit(2); }",
      "  console.log(JSON.stringify({image: JSON.parse(process.env.FIXTURE_TASK_IMAGES)[Number(args[3].slice(4))], state: process.env.FIXTURE_TASK_STATE}));",
      "} else if (command === 'stack deploy') { console.log('DEPLOY_IMAGE=' + process.env.APP_IMAGE); console.log('WEB_ENV_FILE=' + process.env.WEB_ENV_FILE);",
      "} else { console.error('Unexpected Docker invocation: ' + args.join(' ')); process.exit(2); }",
    ].join("\n"),
  );
  chmodSync(dockerPath, 0o755);
  const sshPath = join(directory, "ssh");
  writeFileSync(sshPath, "#!/usr/bin/env node\nprocess.exit(0);\n");
  chmodSync(sshPath, 0o755);
  try {
    const options: SpawnSyncOptionsWithStringEncoding = {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH ?? ""}`,
        IMAGE_TAG: "requested",
        STACK_NAME: "dofek",
        SSH_USER: "fixture",
        DOCKER_HOST: "ssh://fixture@example.test",
        GITHUB_OUTPUT: outputPath,
        FIXTURE_CALLS: callsPath,
        FIXTURE_MOVED: join(directory, "moved"),
        FIXTURE_DIGEST: JSON.stringify(digest),
        FIXTURE_PINNED_DIGEST: deployTestDigest,
        FIXTURE_DESIRED: desiredImage,
        FIXTURE_RELEASE: release,
        FIXTURE_FAILURE: failure,
        FIXTURE_TASK_IMAGES: JSON.stringify(taskImages),
        FIXTURE_TASK_STATE: taskState,
        FIXTURE_REPLICAS: String(desiredReplicas),
        RUNNER_TEMP: directory,
        INFISICAL_ENV_FILE: dotenvPath,
        WEB_PRE_MIGRATION_ENV_FILE: "old-web.env",
        STACK_FILE_FLAGS: "-c deploy/stack.yml",
        ...environment,
      },
    };
    const result = script
      ? spawnSync("bash", ["-e", "-o", "pipefail", "-c", script], options)
      : spawnSync(
          resolve("node_modules/.bin/tsx"),
          [resolve("scripts", filename), ...args],
          options,
        );
    return {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
      output: readFileSync(outputPath, "utf8"),
      calls: readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line): string[] => JSON.parse(line)),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
