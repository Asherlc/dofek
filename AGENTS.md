# Health Data

Read [README.md](README.md) first for architecture, commands, and deployment runbooks. `AGENTS.md` is the canonical agent guidance; `CLAUDE.md` and `GEMINI.md` are same-directory symlinks.

## General

- **Minimum sound change**: Meet the complete current requirement with the least maintained custom code and machinery. Prefer stock platforms, established tools, and existing workflows; research current authoritative guidance and off-the-shelf alternatives before DIY. Evaluate maintenance, adoption, security, licensing, and operational trade-offs ([OpenSSF Scorecard](https://scorecard.dev/) can inform security review). Use the smallest domain abstraction actual callers need, consolidate duplicate tools, and follow YAGNI. Do not add unrelated error handling, validation, infrastructure, or speculative future-proofing. Preserve correctness, safety, operability, and maintainability rather than minimizing lines; use [Google's review dimensions](https://google.github.io/eng-practices/review/reviewer/looking-for.html).
- **Confirm direction**: Before a non-trivial implementation, strategy, workaround, or choice with meaningful trade-offs, confirm the approach with the user. Ask before departing from YAGNI, cutting corners, or pursuing a hacky fix.
- **No branch switching without approval**: Never switch branches, create a branch from another branch, or rebase onto another branch without explicit user approval.
- **Persist; ask before pivoting**: Exhaust reasonable options for the chosen strategy. Before changing it, state the current strategy, attempted steps and evidence, why it is blocked, and one alternative; ask for approval in one sentence. Do not execute alternative commands or edits before approval.
- **Durable steady state**: Merged production code, configuration, scripts, and workflows must describe the intended steady state. Keep one-time diagnosis/remediation as operator actions. Do not retain incident-specific branches, forced optimizer settings, oversized temporary timeouts, diagnostic-only instrumentation, cleanup hooks, temporary flags, manual-removal TODOs, or commented-out dead code/config. Retain generally useful observability, regression tests, reproducible migrations, and incident documentation.
- **Missing providers**: “I can't see a provider” means its validation is failing. Use the `fix-provider` skill to diagnose missing configuration or credentials; intentionally disabled providers remain hidden.
- **Latest stable versions**: Verify the current latest stable release when adding or updating dependencies, images, services, artifacts, or tools. Pin specific production versions rather than `latest`.
- **Repository scripts**: Use TypeScript (`.ts`) with `pnpm tsx`; Python tooling belongs only inside `packages/ml`.
- **Package manager**: Always use pnpm, never npm or yarn.

## Agent Documentation

- **Local guidance**: Keep shared package/directory context in its README. Add a scoped `AGENTS.md` only for additional agent-specific rules; omit README-only or inherited-rule duplicates. Every retained `AGENTS.md` must instruct agents to read its sibling README first and have same-directory `CLAUDE.md` and `GEMINI.md` symlinks to it.
- **Audience**: Keep agent-only instructions here; put shared architecture, commands, and runbooks in README or `docs/`. Human documentation must stand alone without skills or an agent present. Update it with significant changes and external API, format, authentication, or provider findings.
- **Sources**: Cite official documentation, specifications, or primary sources for claims added or updated in `AGENTS.md`, `README.md`, and `docs/`; do not assert third-party behavior without evidence.
- **Portable skills**: Keep repository skills in `.agents/skills/<name>/SKILL.md` using the [Agent Skills specification](https://agentskills.io/specification). Keep `.claude/skills` as a relative link to that directory. Use explicit request inputs and command instructions instead of harness-specific substitutions. See [shared skill discovery and layout](docs/development-environment.md#shared-agent-skills) before adding skills or aliases.
- **Written plans**: Record the approved scope, acceptance criteria, and task order in working notes. Before each task, read its requirements; for behavior changes, observe the regression test fail before implementation and pass afterward, subject to the approved test-policy exceptions. After each task, review scope/spec compliance, maintainability, and verification evidence; fix material findings before continuing. Finish with a whole-change review by an independent reviewer when available and authorized; otherwise explicitly report a separate self-review. Resolve material findings and confirm required checks before reporting readiness. Keep these checkpoints explicit. Available plugin workflows are optional ways to meet them; no particular plugin is required.

## End-of-Task Retrospective

- Close each task with a short account of what worked, what needed investigation, useful context for next time, and missing or unclear guidance. Propose concrete wording/runbook improvements and relevant existing or missing skills for user approval.
- After production incidents, deploy failures, infrastructure/database pressure, CI/deploy outages, or operational debugging, append the date, symptoms, user impact, evidence, root cause (or explicitly unresolved status), fix/mitigation, remaining risk, and follow-up to [the incident baseline](docs/production-incident-baseline.md).

## Debugging

- **Evidence before behavior changes**: Reproduce and diagnose the failure before fixing it. For CI/deploy/infra incidents, capture and cite the exact failing command/step, first fatal log line, and causal explanation. For production debugging, verify working logs/metrics/traces first; repair missing instrumentation before attempting the fix. Confirm hypotheses with evidence rather than “likely” explanations.
- **Root cause before mitigations**: Fix the underlying cause before adding timeouts, retries, sleeps, fallback defaults, compatibility layers, `continue-on-error`, or warn-and-continue behavior. Do not suppress or delay failures as a fix. Justify any resilience tuning that remains after the direct fix. If the cause remains unknown after initial investigation, stop and ask for direction.
- **Fail fast**: Missing required secrets, environment files, configuration, or dependencies must hard-fail immediately with explicit key names. Never silently degrade, swallow errors, or continue with broken state. Ask before disabling checks, adding ignores, taking shortcuts, or introducing temporary migration bridges.
- **Loading performance**: Follow [the loading runbook](docs/performance/loading-performance-runbook.md) first for slow web/mobile loads, blank dashboards, slow tRPC batches, ClickHouse queueing, or query bottlenecks. Classify with Axiom or recorded evidence, preserve stale data during background client refetches, and add ClickHouse/dbt models only when evidence names a request-time query bottleneck.
- **Postgres outages**: Use `.agents/skills/db-incident-response/SKILL.md` first for recovery mode, restart loops, or disk pressure.
- **New environment variables**: Verify each newly referenced variable exists in Infisical for every relevant environment; create missing keys before considering the task done, merging, or deploying.
- **Diagnose operator-workstation Infisical sessions before repeating login instructions**: Record `command -v infisical`, `mise which infisical`, and both versions (Homebrew/mise can differ). Before concluding logout, retry a read-only names-only check with necessary access: `infisical export --env=prod --format=json | jq -r '.[].key'`. Never print raw exports or secret values. This workstation procedure excludes the Cursor VM without Infisical and production, where CI exports secrets. Before `infisical secrets set`, redirect both streams away from tool output, then verify key names; `--silent` alone is insufficient. See [Infisical CLI](https://infisical.com/docs/cli/overview).
- **Incident completion**: Report the root cause in one sentence, its direct fix, successful validation without ad-hoc waits, and a one-line justification for each remaining resilience knob.

## Development and Validation

Before implementing or reviewing application/tooling changes, read [Development Policy](docs/development-environment.md#development-policy) and [Test Policy](docs/testing.md#test-policy). Before schema, provider, ingestion, or analytics changes, also read [Storage and Ingestion Policy](docs/schema.md#storage-and-ingestion-policy). These policies remain required; the links replace duplicated instructions here. Read the relevant local README before work in a package or directory, even when it has no scoped agent guide.

- **Use the workspace Compose wrapper**: Use `pnpm compose -- <arguments>` or repository scripts with the same physical-workspace identity. Never use raw `docker compose` in Conductor automation: stale inherited working directories can target another workspace. See [project isolation](https://docs.docker.com/compose/how-tos/project-name/) and [`--project-directory`](https://docs.docker.com/reference/cli/docker/compose/).
- **Archive workspace Docker state**: The Conductor archive hook must remove that workspace's default/E2E containers, networks, and named volumes with `down --remove-orphans --volumes`. Preserve other workspaces, shared images, and build cache. See [Compose down scope](https://docs.docker.com/reference/cli/docker/compose/down/).
- **Standing Docker cleanup approval**: The user authorizes removing stopped containers (including other workspaces), pruning rebuildable build cache, and unused images. On disk exhaustion, start with current-workspace disposable resources and `docker builder prune -af`, then inspected stopped containers/unused images. Recheck state immediately before removal. Never force-remove running containers or delete named database volumes under this approval; `docker volume prune` and `docker system prune --volumes` require additional approval. See [container removal](https://docs.docker.com/reference/cli/docker/container/rm/), [pruning](https://docs.docker.com/engine/manage-resources/pruning/), and [local recovery](docs/testing.md#docker-disk-recovery).
- **Commit regularly**: Commit at regular intervals — after each meaningful chunk of work (new feature, passing tests, refactor). Don't let changes accumulate.
- **Always push after commit**: Push to remote after every commit so CI runs and changes are backed up.
- **Pre-push checks**: Assess the whole PR scope and validate the changed behavior. For prose, non-executable skill metadata, and guidance/config symlink-only changes, use focused metadata/schema checks, link inspection, native discovery, and diff review; application lint, typechecks, and tests are unnecessary unless those changes affect runtime behavior, test selection, permissions, deployment, or CI. Executable tooling still needs relevant lint, typechecks, and behavior tests. For application changes, run `pnpm lint`, typecheck all packages (`pnpm --recursive --include-workspace-root --if-present typecheck`), and relevant non-interactive unit/mobile tests. Run real-engine integration tests for database behavior. Reuse successful checks for unchanged code/configuration; do not rerun heavyweight suites solely for later prose/link edits. Do not run local E2E/Cypress unless E2E tests change; preserve the Docker validation rule below. Never suppress failures or change required CI gates; do not declare the PR ready until all required checks pass.
- **Test Docker changes locally end-to-end**: Before pushing Dockerfile/entrypoint edits, build and run the server container against a real database; verify startup, migrations, API responses, and SPA serving. Use [the canonical workspace Compose setup](docs/development-environment.md#commands), not a separate ad-hoc network, fixed sleeps, or an outdated image recipe.
- **Run migrations**: After generating a migration from schema changes, always run `pnpm migrate` yourself — don't tell the user to do it.
- **Never modify repo settings**: Never change GitHub branch protection, required checks, rulesets, or other repository settings through API/CLI. Ask how to proceed if protection blocks merging.
- **Validate infrastructure changes locally before PRs**: For deployment/infrastructure edits (`deploy/*.tf`, server cloud-init, stack, collector config), run `terraform plan` and `terraform apply` locally with Infisical secrets, plus `docker stack config -c deploy/stack.yml`. Verify actual operation before push/PR; CI apply is not a substitute.
- **No manual server changes**: Use committed `deploy/stack.yml` or Terraform for server configuration. SSH is read-only diagnosis (logs, container status, state), never direct configuration editing; the durable fix belongs in code/infrastructure. Follow [README deployment procedures](README.md).
- **Drizzle generate is interactive**: `pnpm generate` can prompt about renames. When unattended generation would prompt, write sequential migration SQL manually, then always run `pnpm migrate` yourself.

## Code Review

- **Flag linter-catchable issues**: During code reviews, still flag violations even if they would be caught by a linter. Do not skip issues just because a linter or Biome plugin enforces them — the review should catch everything, not defer to CI.

## Commands

Use the command references in [README.md](README.md), [the testing guide](docs/testing.md), and [development setup](docs/development-environment.md). Keep command definitions in `package.json` and `mise.toml` rather than duplicating catalogs here.

## CI

- **Swarm deploy release unit**: Normal web releases use one `docker stack deploy` for web and worker with the same image tag; do not split them into separate deploy jobs/workflows.
- **Knip unused code analysis**: Register new package runtime entry points in root `knip.json`. For whole-package false positives, verify its entry point first.
- **Use the `gh` CLI**: Use `gh` for status and job logs, never scrape the UI or curl raw APIs. Follow [CI debugging](docs/ci-debugging.md) to extract fatal errors from truncated logs, including iOS output piped through `tail`.
- **Use the CI fix skill**: Use the repository `gh-fix-ci` skill for failing Actions checks: inspect logs, extract the first fatal error, prove the cause, implement the minimum direct fix, validate locally and rerun, then report evidence.
- **Keep workflow steps as granular as possible for visibility**: Use small, clearly named CI steps (environment export, readiness, migration, deploy) so progress and failures are visible.
- **Periodically check CI runs** to catch failures early. Before starting work, check if CI is green.
- **Never rerun flaky CI as a fix**: Diagnose and fix every failure, including network, installation, and timing flakes. A rerun alone is not a solution.
- **Prefer Terraform-native CI approaches**: Use Terraform providers, `templatefile()`, and CI plan/apply for infrastructure rather than ad-hoc shell or manual curl/sed pipelines.

## Cloud Environments

Read [the cloud environment runbook](docs/development-environment.md#cloud-and-prebuilt-environments) and its [provider-specific notes](docs/development-environment.md#provider-specific-environments) before setup. Do not assume snapshots share Docker privileges, installed tools, or runtime secrets.

For Codex Cloud without Docker privileges, use the documented `SANDBOX=1` startup and `mise run test:sandbox`. Still write required real-engine integration tests and explicitly report them as not run locally; CI runs the database tier. Do not claim unexecuted tests passed.
