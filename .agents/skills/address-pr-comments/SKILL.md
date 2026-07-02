---
name: address-pr-comments
description: Review all actionable PR feedback, including unresolved inline threads and PR-level review bodies, then fix valid issues and respond with concrete fix details or a clear skip reason.
---

# Address PR Comments

Review every actionable comment on the current PR. That includes unresolved inline review threads and PR-level review bodies (for example, links like `#pullrequestreview-1234567890`). For each one, determine if it's valid, take action, and respond in the right place.

## Current state

- Branch: !`git branch --show-current`
- Status: !`git status --short`
- Repo: !`gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo "unknown"`
- PR: !`gh pr view --json number,url -q '"#\(.number) \(.url)"' 2>/dev/null || echo "no PR found"`

## Steps

### 1. Find the PR and fetch all review feedback

Get the PR number for the current branch:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
```

Fetch all review feedback:

```bash
# Review comments on specific lines
gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments --paginate

# PR reviews, including top-level review bodies like #pullrequestreview-...
gh pr view ${PR_NUMBER} --json reviews

# PR review threads (to check resolved status). Use GraphQL because gh pr view
# does not expose reviewThreads in every environment.
gh api graphql -f query='query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { id isResolved isOutdated path line originalLine comments(first:20) { nodes { id databaseId body url createdAt author { login } } } } } } } }' -F owner={owner} -F repo={repo} -F number=${PR_NUMBER}
```

### 2. Filter to actionable comments

From the review threads response, identify threads where `isResolved` is `false`. Match these to their comments to get the full comment body, file path, line number, and thread ID.

From the PR reviews response, identify review entries with a non-empty `body`. Treat these as PR-level review comments even though they are not part of a resolvable inline thread. These appear at URLs like `https://github.com/{owner}/{repo}/pull/{number}#pullrequestreview-...`.

Ignore empty review bodies and obvious service-status noise that is not actionable review feedback, such as quota-limit banners, paused-review notices, or "unable to review" messages from tooling bots.

If there are no actionable inline threads or PR-level review bodies, report that and stop.

### 3. Process each actionable comment

For each unresolved inline comment or PR-level review body:

#### a. Understand the comment

- Read the comment body carefully.
- Read the referenced file and surrounding code to understand context.
- Check the diff to understand what changed and why.
- For PR-level review bodies, break multi-bullet feedback into distinct actionable items and address each one.

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
5. Reply to the comment with what changed and the commit link. Use one of these formats:
   ```text
   Fixed.
   - <file or behavior changed #1>
   - <file or behavior changed #2>
   - Commit: <commit-url>
   ```
   ```text
   Already fixed.
   - <what was already changed>
   - Commit: <commit-url>
   ```
   Do not post a bare "Fixed in <commit-url>" reply.
6. Post the reply in the right place:
   ```bash
   # Inline review comment reply
   gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies \
     -f body="<detailed-reply>"
   ```
   ```bash
   # PR-level review body follow-up: post a top-level PR comment that references
   # the review URL and summarizes what was fixed
   gh pr comment ${PR_NUMBER} --body "<detailed-reply>"
   ```
7. Resolve the thread when the feedback came from an inline review thread:
   ```bash
   gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "THREAD_NODE_ID"}) { thread { isResolved } } }'
   ```
   PR-level review bodies cannot be resolved with `resolveReviewThread`; do not try to fabricate a thread ID for them.

**If not valid:**

1. Reply to the comment explaining specifically why the change is being skipped. Be respectful and cite project conventions or code context as evidence.
   Use this format:
   ```text
   Not applying this change.
   - Reason: <why this is not needed or would be harmful>
   - Evidence: <code context, convention, or existing behavior>
   ```
   ```bash
   # Inline review comment reply
   gh api repos/{owner}/{repo}/pulls/${PR_NUMBER}/comments/${COMMENT_ID}/replies \
     -f body="<explanation>"
   ```
   ```bash
   # PR-level review body follow-up
   gh pr comment ${PR_NUMBER} --body "<explanation>"
   ```
2. Resolve the thread only when the feedback came from an inline thread:
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
- Reply on every actionable item. Inline comments should get thread replies; PR-level review bodies should get a top-level PR comment referencing the review URL.
- Every reply must include either detailed fix notes (or already-fixed notes) with a commit URL, or a clear skip reason with evidence.
- If a comment requires a design decision or is ambiguous, ask the user instead of guessing.
- Batch related fixes into a single commit when they address the same concern.
- Run all pre-push checks before pushing, per project rules.
