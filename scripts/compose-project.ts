import { basename, join } from "node:path";

const projectSuffixFlag = "--project-suffix";

export interface ComposeProjectIdentity {
  composeEnvironmentPath: string;
  composeProjectName: string;
  projectSuffix: string | null;
}

export function resolveComposeProjectIdentity(
  workspaceDirectory: string,
  arguments_: readonly string[],
): ComposeProjectIdentity {
  const projectSuffixIndex = arguments_.indexOf(projectSuffixFlag);
  const projectSuffix = projectSuffixIndex === -1 ? null : arguments_[projectSuffixIndex + 1];
  if (projectSuffixIndex !== -1) {
    if (!projectSuffix || !/^[a-z0-9][a-z0-9_-]*$/.test(projectSuffix)) {
      throw new Error("--project-suffix requires a lowercase alphanumeric Compose name suffix");
    }
    if (arguments_.indexOf(projectSuffixFlag, projectSuffixIndex + 1) !== -1) {
      throw new Error("--project-suffix can only be specified once");
    }
  }

  const baseComposeProjectName = basename(workspaceDirectory);
  return {
    composeEnvironmentPath: join(
      workspaceDirectory,
      projectSuffix === null ? ".env.local" : `.env.${projectSuffix}.local`,
    ),
    composeProjectName:
      projectSuffix === null
        ? baseComposeProjectName
        : `${baseComposeProjectName}-${projectSuffix}`,
    projectSuffix,
  };
}
