# Docs Agent Instructions

> **Read the [README.md](./README.md) first** for an overview of available documentation.

## High-Level Mandates
- **Document as you go**: Every new provider or major architectural change MUST be documented in `docs/`.
- **Prefer Markdown**: All documentation should be in GitHub-flavored Markdown.
- **Cite Research**: When reverse-engineering, document the specific methods used (e.g., "Discovered via jadx decompilation of v5.43.0") to aid future debugging.
- **Keep Diagrams Current**: Run `scripts/generate-schema-diagram.ts` after any schema change to keep the ERDs in sync.

## Common Tasks

### Researching a New Provider
1. Start by searching for existing research in `docs/reverse-engineering-apis.md`.
2. Document your findings in a new `<provider>.md` file.
3. If using BLE, add protocol details to a dedicated file or the provider doc.

### Debugging iOS CI
If an iOS build fails with a generic error:
1. Refer to `docs/ci-debugging.md`.
2. Use `gh api` to download the full logs and grep for "error:".

## Guardrails
- **No Secrets**: Never commit real API keys, tokens, or personal credentials to documentation. Use placeholders.
- **Raw Data Philosophy**: Before adding a new table or column, verify it aligns with the "Raw Data Only" philosophy in `docs/schema.md`.
