---
description: Address code review comments on a PR — fix or reply to every comment
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent, mcp__github__get_pull_request_comments, mcp__github__get_pull_request_reviews, mcp__github__add_issue_comment, mcp__github__add_reply_to_pull_request_comment
---

# Address CR Comments

Fetch all review comments on the PR for the current branch, then address each one.

## Steps

1. **Find the PR**: `gh pr view --json number,url` for the current branch.
2. **Fetch comments**: Use `gh api repos/Asherlc/dofek/pulls/<PR_NUMBER>/comments` and `gh api repos/Asherlc/dofek/pulls/<PR_NUMBER>/reviews` to get all review comments.
3. **Skip noise**: Ignore bot-only comments with no actionable feedback (Codecov, Storybook preview links, Copilot summary headers, etc.).
4. **Address each substantive comment** — every comment gets a reply, no exceptions:

   **If fixing:**
   - Make the code change
   - Commit with a descriptive message
   - Push
   - Reply to the comment with: what was fixed and a link to the commit (e.g., `Fixed in abc1234`)

   **If declining:**
   - Reply to the comment explaining specifically why you're not making the change
   - Cite code, docs, or project conventions that support the decision
   - Don't be dismissive — acknowledge the reviewer's point even when disagreeing

5. **Reply directly on comment threads** using `gh api repos/Asherlc/dofek/pulls/<PR_NUMBER>/comments/<COMMENT_ID>/replies -f body="..."` so the reply appears inline next to the code, not as a top-level PR comment.
6. **Post a summary** as a top-level PR comment listing what was fixed and what was declined with reasons.

## Reply format

For fixes:
```
Fixed in [`<short-sha>`](<commit-url>). <one-line description of what changed>
```

For declines:
```
Skipping — <reason>. <supporting evidence>
```
