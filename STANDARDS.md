# Review Standards

## Monorepo Packages

- This repository uses private pnpm workspace packages declared in `pnpm-workspace.yaml`.
- Internal packages use the `@dofek/*` scope and are consumed with `workspace:*` dependencies in package manifests.
- Do not flag `@dofek/*` imports as hallucinated packages only because they are not published on npm.
- Resolve dependencies from the importing package's nearest `package.json`, not only from the repository root `package.json`.
- Package-specific dependencies may live in manifests such as `packages/web/package.json`, `packages/mobile/package.json`, or another workspace package manifest.
- Prefer canonical workspace-package imports, such as `@dofek/training/training-load`, over relative cross-package source imports.
