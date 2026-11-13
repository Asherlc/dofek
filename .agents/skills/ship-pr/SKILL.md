---
name: ship-pr
description: Validate a branch, push it, open or update its pull request, and monitor required CI checks and actionable review feedback.
---

# Ship PR

Follow the root [agent guidance](../../../AGENTS.md),
[test policy](../../../docs/testing.md#test-policy), and
[development workflow](../../../README.md#development).
Never switch/rebase branches, change repository settings, force-push, skip
hooks, enable auto-merge, or merge without the user's required approval.

## 1. Inspect the branch and choose validation

```bash
rtk git branch --show-current
rtk git status --short
rtk git remote -v
rtk git diff origin/main...HEAD --stat
```

Assess the whole PR and current uncommitted work. Reuse successful evidence
for unchanged code/configuration; later prose/link edits alone do not require
repeating heavyweight suites.

- For prose, non-executable skill metadata, and guidance/config symlink-only
  changes: inspect the diff, validate metadata with existing schema-aware tools,
  check link targets, and verify affected native discovery. Application lint,
  typechecks, and tests are unnecessary when runtime behavior, test selection,
  permissions, deployment, and CI are unaffected.
- Executable tooling still requires relevant lint, typechecks, and behavior tests.
- Application changes require the applicable checks below, focused tests for
  changed behavior, and the integration tier for database semantics. Keep the
  full regression scope when the change warrants it.
- Declarative files that alter runtime behavior, permissions, deployment,
  test selection, or CI do not receive the metadata-only exemption.

```bash
rtk pnpm lint
rtk pnpm --recursive --include-workspace-root --if-present typecheck
rtk pnpm test run
# When database behavior changes:
rtk pnpm test:integration
```

Run local E2E/Cypress only when E2E tests change; preserve the separate
Dockerfile/entrypoint end-to-end validation requirement. Required CI gates
remain unchanged for every PR.

All errors must be addressed before reporting readiness, including pre-existing
ones. Diagnose and fix within the approved scope; report blockers and seek
alignment when a fix would require a new non-trivial strategy or permissions.
Never suppress failures or treat a rerun as the fix. Long-running checks may
continue while the PR is opened, but the PR is not ready until they pass.

## 2. Commit, push, and open or update the PR

Review the final diff, commit meaningful changes, and push the current branch:

```bash
rtk git push -u origin HEAD
```

Write the exact PR description to a temporary Markdown file, then use
`rtk gh pr create --base main --title "<title>" --body-file <file>`.
If this branch already has an open PR, update it with
`rtk gh pr edit <number> --title "<title>" --body-file <file>`.
Use real values in place of placeholders. Do not pass multiline bodies inline.
Describe final behavior and validation, including checks intentionally not run.

## 3. Monitor CI and review feedback

```bash
rtk gh pr checks <number> --watch
rtk gh pr view <number> --json comments,reviews
rtk gh api repos/<owner>/<repo>/pulls/<number>/comments
```

Use `gh pr view --json reviews` for review bodies; `gh pr review` submits a
review and has no `list` subcommand. Inspect both PR-level review bodies and
inline threads, not just inline comments.

For failures, read the failing job with `rtk gh run view <run-id> --log-failed`,
identify the first fatal error and cause, then make and validate the direct fix.
Do not call the PR ready while required checks fail or remain pending.

Assess actionable feedback on its merits. In an invoked PR workflow, fix valid
issues within scope, reply with the fix commit or a concrete reason for skipping,
and resolve addressed threads. Preserve authorization boundaries for external
messages. If fixes require another push, rerun relevant checks and monitor the
new revision. Paid-review quota/size-limit notices are not code findings.

Once required checks pass and material feedback is addressed, report the PR as
ready for manual review/merge. Do not merge it automatically.
