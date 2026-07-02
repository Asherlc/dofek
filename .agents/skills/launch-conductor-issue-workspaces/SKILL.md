---
name: launch-conductor-issue-workspaces
description: Use when the user wants to open or create Conductor workspaces from GitHub issues, batch-launch issue workspaces, or avoid attaching issue workspaces to the wrong repository root.
---

# Launch Conductor Issue Workspaces

## Overview

Open one Conductor workspace per GitHub issue using Conductor deep links. Always target the repository's main worktree root, not the current Conductor workspace path.

## Workflow

1. Confirm the request scope: issue numbers/URLs, a GitHub search query, or the default first open issues.
2. Run the helper from the repository workspace:

```bash
rtk pnpm tsx .agents/skills/launch-conductor-issue-workspaces/scripts/open-conductor-issue-workspaces.ts --limit 10
```

3. If the user says the workspaces opened under the wrong repo, rerun with an explicit root:

```bash
rtk pnpm tsx .agents/skills/launch-conductor-issue-workspaces/scripts/open-conductor-issue-workspaces.ts --repo-root ~/src/dofek --limit 10
```

4. Report the exact issue numbers opened and the repo root used.

## Common Commands

Open the first 10 open issues:

```bash
rtk pnpm tsx .agents/skills/launch-conductor-issue-workspaces/scripts/open-conductor-issue-workspaces.ts --limit 10
```

Preview without opening Conductor:

```bash
rtk pnpm tsx .agents/skills/launch-conductor-issue-workspaces/scripts/open-conductor-issue-workspaces.ts --limit 10 --dry-run
```

Open specific issues:

```bash
rtk pnpm tsx .agents/skills/launch-conductor-issue-workspaces/scripts/open-conductor-issue-workspaces.ts 1434 1435 1436
```

Filter with GitHub issue search syntax:

```bash
rtk pnpm tsx .agents/skills/launch-conductor-issue-workspaces/scripts/open-conductor-issue-workspaces.ts --search "label:loading-perf state:open" --limit 20
```

## Guardrails

- Do not use `git rev-parse --show-toplevel` alone from inside a Conductor workspace; that returns the workspace path and can make Conductor attach the new workspace to the wrong repo entry.
- Prefer the helper's default main-worktree detection from `git worktree list --porcelain`.
- Use `--repo-root` when the intended repo root is known, such as `~/src/dofek`.
- This deep-link workflow controls prompt and repo path. It does not reliably control model, provider, reasoning effort, approval mode, or fast mode.
- If Conductor does not open the expected repo, ask the user to confirm the repo's main root in Conductor and rerun with `--repo-root`.

## Script

Use `scripts/open-conductor-issue-workspaces.ts`. It requires:

- macOS `open`
- GitHub CLI authenticated for the target repo
- `pnpm tsx`
