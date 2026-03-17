---
name: address-pr-comments
description: Review all unresolved PR comments, fix valid issues (commit + reply with link), explain and resolve invalid ones.
---

# Address PR Comments

Review every unresolved comment on the current PR. For each one, determine if it's valid, take action, and resolve the thread.

## Current state

- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Repo: !`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "unknown"`
- PR: !`gh pr view --json number,url -q '"#\(.number) \(.url)"' 2>/dev/null || echo "no PR found"`

## Steps

### 1. Find the PR and fetch all review comments

Get the PR number for the current branch:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
```

Fetch all review comments (both regular review comments and PR-level review threads):

```bash
# Review comments on specific lines
gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments --paginate

# PR review threads (to check resolved status)
gh pr view ${PR_NUMBER} --json reviewThreads
```

### 2. Filter to unresolved comments

From the review threads response, identify threads where `isResolved` is `false`. Match these to their comments to get the full comment body, file path, line number, and thread ID.

If there are no unresolved comments, report that and stop.

### 3. Process each unresolved comment

For each unresolved comment:

#### a. Understand the comment

- Read the comment body carefully.
- Read the referenced file and surrounding code to understand context.
- Check the diff to understand what changed and why.

#### b. Assess validity

Determine whether the comment identifies a real issue:
- **Valid**: Bug, correctness issue, missing edge case, style violation per project rules (CLAUDE.md), unclear code, missing tests, security concern, or any other legitimate improvement.
- **Not valid**: Misunderstanding of the code, outdated concern already addressed, stylistic preference not backed by project conventions, or suggestion that would make the code worse.

#### c. Take action

**If valid:**

1. Fix the issue in the code.
2. Run pre-push checks to make sure the fix doesn't break anything:
   ```bash
   pnpm lint
   pnpm tsc --noEmit
   cd packages/server && pnpm tsc --noEmit
   cd packages/web && pnpm tsc --noEmit
   pnpm test
   ```
3. Commit the fix with a clear message referencing the comment.
4. Note the commit SHA for the reply.
5. Reply to the comment with a link to the fix commit:
   ```bash
   gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies \
     -f body="Fixed in <commit-url>"
   ```
6. Resolve the thread:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) { thread { isResolved } } }'
   ```

**If not valid:**

1. Reply to the comment explaining specifically why the change isn't needed. Be respectful and cite project conventions or code context as evidence.
   ```bash
   gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies \
     -f body="<explanation>"
   ```
2. Resolve the thread:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) { thread { isResolved } } }'
   ```

### 4. Push and report

After processing all comments:

1. If any code changes were made, push:
   ```bash
   git push
   ```
2. Report a summary of what was done:
   - How many comments were addressed
   - Which were fixed (with commit links)
   - Which were declined (with brief reasons)

## Important

- Never force push or skip hooks.
- Fix issues properly — no workarounds or disabled lint rules.
- If a comment requires a design decision or is ambiguous, ask the user instead of guessing.
- Batch related fixes into a single commit when they address the same concern.
- Run all pre-push checks before pushing, per project rules.
