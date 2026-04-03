---
description: Address code review comments on a PR
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, Agent, mcp__github__get_pull_request_comments, mcp__github__get_pull_request_reviews, mcp__github__add_issue_comment
---

# Address CR Comments

Fetch all review comments on the PR for the current branch, then address each one:

1. Use `gh api repos/Asherlc/dofek/pulls/<PR_NUMBER>/comments` and `gh api repos/Asherlc/dofek/pulls/<PR_NUMBER>/reviews` to get all comments. Find the PR number from `gh pr view --json number`.
2. Skip bot-only comments with no actionable feedback (Codecov, Storybook preview, etc.).
3. For each substantive review comment:
   - If the comment is valid: fix the code, commit, push, and reply on the comment thread explaining the fix.
   - If the comment is wrong or not applicable: reply on the comment thread explaining why you're not making the change. Be specific — cite the code or docs that show why.
   - Never silently skip a comment. Every substantive comment gets either a fix or a rebuttal.
4. After addressing all comments, post a summary as a PR comment listing what was fixed and what was declined with reasons.
