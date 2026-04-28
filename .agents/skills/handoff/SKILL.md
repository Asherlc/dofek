---
name: handoff
description: Use when the user asks to hand off current work to another agent, summarize in-progress work, capture unresolved tasks, or create copy-paste continuation context.
---

# Handoff

Create a concise, copy-pasteable handoff that lets another agent continue seamlessly without rereading the whole conversation.

## Output Contract

Produce a standalone handoff block. Assume the receiving agent can read the repo but cannot see prior chat context.

Include these sections, omitting only sections that are truly irrelevant:

1. **Goal**: The user-facing objective and why it matters.
2. **Current State**: What has already been discovered, changed, mitigated, or decided.
3. **Files Changed**: Paths touched and the purpose of each change.
4. **Evidence**: Key commands, logs, errors, incident facts, or validation results already gathered.
5. **Still To Do**: Ordered next actions, including validation, deploy, commit, push, or follow-up docs.
6. **Constraints**: Relevant repo rules, user preferences, branch/worktree state, commands not to run, and approval gates.
7. **Risks / Watchouts**: Known uncertainties, possible regressions, or places where assumptions could be wrong.
8. **Recommended Next Step**: The single best immediate action for the next agent.

## Style

- Make it directly pasteable into a new agent chat.
- Prefer concrete paths, command outputs, dates, and exact error strings over narrative.
- Distinguish facts from assumptions.
- Do not claim work is complete unless it was verified.
- Do not include private chain-of-thought; summarize decisions and evidence only.
- Keep it compact, but include enough context to avoid rediscovery.

## Template

```markdown
Task Context: <short title>

Goal:
<what the user wants and the operational/product reason>

Current State:
- <fact/change/decision>

Files Changed:
- `<path>`: <purpose>

Evidence:
- `<command or source>`: <result>
- Exact error/log: `<message>`

Still To Do:
1. <next action>
2. <next action>

Constraints:
- <repo/user/process rule>

Risks / Watchouts:
- <risk or unknown>

Recommended Next Step:
<one immediate action>
```
