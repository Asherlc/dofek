---
name: ship-pr
description: Run all pre-push checks (lint, typecheck, tests), open a PR, enable auto-merge, and monitor CI until the PR is merged.
disable-model-invocation: true
---

# Ship PR

Run all checks, open a PR, auto-merge, and monitor CI to completion.

## Current state

- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Remote: !`git remote -v | head -1`

## Steps

### 1. Pre-push checks

Run all checks. If any fail, stop and fix or report:

```
pnpm lint
pnpm tsc --noEmit
cd packages/server && pnpm tsc --noEmit
cd packages/web && pnpm tsc --noEmit
pnpm test
```

If checks fail, attempt to fix lint/type errors automatically. If tests fail, stop and report the failures to the user.

### 2. Push and open PR

- Push the current branch: `git push -u origin HEAD`
- Create a PR against `main` using `gh pr create`. Write a clear title and summary based on the commits on this branch vs main.
- Use `gh pr merge --auto --squash` to enable auto-merge.

### 3. Monitor CI and PR comments

After opening the PR, monitor both CI status and PR comments in a loop until the PR is merged or blocked.

#### CI monitoring

Poll CI status using `gh pr checks` until all checks pass or one fails:

```bash
gh pr checks --watch
```

- If CI passes and the PR merges (auto-merge enabled), report success.
- If CI fails, report which check failed and show relevant logs using `gh run view <run-id> --log-failed`.
- If the PR hasn't merged after CI passes (e.g. review required), let the user know what's blocking.

#### PR comment monitoring

While waiting for CI and merge, periodically check for new PR review comments:

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments
gh pr review list
```

For each new comment:

1. **Assess validity** — Read the comment carefully. Determine whether it identifies a real issue (bug, style violation, missing edge case, etc.) or is a misunderstanding.
2. **If valid** — Fix the issue, commit, push, and reply to the comment with a link to the fix commit. Then re-run pre-push checks before pushing.
3. **If not valid** — Reply to the comment explaining why you're not making the change. Be respectful and specific.
4. **Resolve the comment** — After replying (whether with a fix or an explanation), resolve the review thread:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_ID"}) { thread { isResolved } } }'
   ```

After addressing comments that required code changes, monitor CI again for the new push.

## Arguments

If `$ARGUMENTS` is provided, use it as the PR title. Otherwise, generate one from the branch commits.

## Important

- Never force push or skip hooks.
- Never merge without CI passing.
- If auto-merge can't be enabled (repo settings), fall back to manual merge after CI passes.
