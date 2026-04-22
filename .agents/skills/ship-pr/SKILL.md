---
name: ship-pr
description: Run all pre-push checks (lint, typecheck, tests), open a PR, and monitor CI until checks finish.
disable-model-invocation: true
---

# Ship PR

Run all checks, open a PR, and monitor CI to completion.

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

ALL errors must be fixed before proceeding — regardless of whether they were introduced in this branch or already existed on main. Fix lint/type errors automatically. If tests fail, stop and report the failures to the user.

### 2. Push and open PR

- Push the current branch: `git push -u origin HEAD`
- Build PR body in a temp markdown file and create the PR with `--body-file` (never inline multiline `--body`, to avoid shell interpolation/mangling):
  ```bash
  pr_body_file="$(mktemp)"
  cat > "$pr_body_file" <<'EOF'
  ## Summary
  - ...
  EOF
  gh pr create --base main --title "$PR_TITLE" --body-file "$pr_body_file"
  rm -f "$pr_body_file"
  ```
- If `gh pr create` reports an existing PR for the branch, update it instead of failing:
  ```bash
  pr_number="$(gh pr view --json number --jq .number)"
  gh pr edit "$pr_number" --title "$PR_TITLE" --body-file "$pr_body_file"
  ```
- Do not enable auto-merge. Never run `gh pr merge --auto --squash` in this skill.

### 3. Monitor CI and PR comments

After opening the PR, monitor both CI status and PR comments in a loop until all checks complete or a failure appears.

#### CI monitoring

Poll CI status using `gh pr checks` until all checks pass or one fails:

```bash
gh pr checks --watch
```

- If CI passes and the PR is merged manually, report success.
- If CI fails, report which check failed and show relevant logs using `gh run view <run-id> --log-failed`.
- If CI passes, report that the PR is ready for manual merge/review.

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
- Never enable auto-merge from this skill.
- For PR descriptions, always use `--body-file`; do not pass multiline markdown directly via `--body`.
