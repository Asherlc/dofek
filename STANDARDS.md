# Review Standards

## Monorepo Packages

- This repository uses private pnpm workspace packages declared in `pnpm-workspace.yaml`.
- Internal packages use the `@dofek/*` scope and are consumed with `workspace:*` dependencies in package manifests.
- Do not flag `@dofek/*` imports as hallucinated packages only because they are not published on npm.
- Prefer canonical workspace-package imports, such as `@dofek/training/training-load`, over relative cross-package source imports.
