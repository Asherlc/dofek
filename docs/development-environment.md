# Development Environment

<!-- cspell:ignore codegraph -->

Dofek uses one checked-in toolchain contract for local workstations,
Conductor workspaces, Dev Containers, and cloud coding environments:

- [`mise.toml`](../mise.toml) declares exact tool versions and task entry
  points.
- [`mise.lock`](../mise.lock) records platform-specific artifact URLs,
  checksums, and available provenance. mise documents the lockfile's integrity
  and provenance behavior in its
  [lockfile reference](https://mise.jdx.dev/dev-tools/mise-lock.html).
- [`docker-compose.yml`](../docker-compose.yml) remains the only definition of
  local application services.
- [`.devcontainer/devcontainer.json`](../.devcontainer/devcontainer.json)
  supplies the Linux host tools and Docker daemon required by portable cloud
  environments. Dev Containers are an
  [open specification](https://containers.dev/) supported by local and cloud
  development products.

NixOS is not required. NixOS would make the operating system part of the
repository contract, while Dofek needs a cross-platform userland toolchain and
a standard cloud container. Nix flakes also remain an
[experimental Nix feature](https://nix.dev/concepts/flakes.html).

## Initialize An Environment

Install mise using its
[platform installation instructions](https://mise.jdx.dev/installing-mise.html),
then run:

```bash
MISE_LOCKED=1 mise install --locked
mise exec -- infisical login
mise run cloud:init
```

`MISE_LOCKED=1` installs only the pinned tool versions recorded in
`mise.lock`; see mise's
[lockfile reference](https://mise.jdx.dev/dev-tools/mise-lock.html). `cloud:init` then:

1. Installs pnpm dependencies with the frozen lockfile.
2. Builds a workspace-local CodeGraph index when one does not exist.
3. Verifies that RTK is executable.
4. Fails immediately if the Docker daemon is unavailable, unless the documented
   `SANDBOX=1` mode explicitly skips the service startup phase.
5. Starts the canonical workspace-isolated Compose services.
6. Applies the Postgres and ClickHouse migrations with Infisical secrets.
7. Runs the complete environment doctor.

mise tasks run with the tools and environment declared in `mise.toml`; see the
[mise task documentation](https://mise.jdx.dev/tasks/).

## Workspace Setup And Archive

[`paseo.json`](../paseo.json) installs the locked toolchain and runs
`cloud:prebuild` during workspace setup. Its teardown and
[Conductor's archive hook](../.conductor/settings.toml) both run
[`scripts/workspace-archive.ts`](../scripts/workspace-archive.ts).
Paseo reads configuration from the committed base branch and runs teardown
during archive before removing the worktree; see its
[worktree lifecycle documentation](https://paseo.sh/docs/worktrees#setup-and-teardown).
Merge configuration changes into the base branch before relying on them in
new workspaces.

Archive removes containers, orphan services, networks, and declared volumes
for `<workspace>`, `<workspace>-e2e`, and `<workspace>-peerdb-integration`.
It includes all profiles and the PeerDB overlay, uses each project's own
environment file when present, and fails if Docker cleanup fails; see the
[cleanup command](../scripts/workspace-archive.ts) and
[Compose shutdown reference](https://docs.docker.com/reference/cli/docker/compose/down/).
Archiving discards those workspaces' local database data. Shared Docker images,
build cache, and package stores remain available for other workspaces.

To verify the lifecycle, start a disposable workspace's backing services and
archive it. For each of the three project names above, replace `PROJECT_NAME`
below and verify that no resources remain:

```bash
docker container ls --all --filter label=com.docker.compose.project=PROJECT_NAME
docker network ls --filter label=com.docker.compose.project=PROJECT_NAME
docker volume ls --filter label=com.docker.compose.project=PROJECT_NAME
```

Docker documents these [resource filters](https://docs.docker.com/engine/cli/filter/).
Keep shared cache pruning separate from workspace archive; see
[Docker disk recovery](testing.md#docker-disk-recovery).

## Cloud And Prebuilt Environments

A cloud provider that supports the Dev Container specification needs only:

```bash
devcontainer up --workspace-folder .
```

The container lifecycle is intentionally split:

- `onCreateCommand` runs `MISE_LOCKED=1 mise install --locked` and
  `mise run cloud:prebuild`. This phase downloads tools and dependencies and
  builds the CodeGraph index without requiring application secrets.
- `postCreateCommand` enables RTK's global Codex instructions and runs
  `mise run cloud:start`. This phase requires Docker and Infisical
  authentication, starts services, and initializes databases.

GitHub Codespaces prebuilds execute creation commands before a user session but
do not expose user-level secrets during the prebuild. The split follows
[GitHub's prebuild lifecycle and secret boundary](https://docs.github.com/en/codespaces/prebuilding-your-codespaces/about-github-codespaces-prebuilds).

For a provider without Dev Container support, reproduce the base dependencies
and pinned vcpkg bootstrap from
[`.devcontainer/Dockerfile`](../.devcontainer/Dockerfile), expose the checkout
through `VCPKG_ROOT`, install the pinned minimum mise version, and use:

```bash
MISE_LOCKED=1 mise install --locked
mise run agent:codex
mise run cloud:init
```

Set `INFISICAL_TOKEN` to a short-lived machine-identity token before
`cloud:init`. The Infisical CLI automatically uses that environment variable
for authentication, as documented by
[Infisical's login command](https://infisical.com/docs/cli/commands/login).
Do not commit the token or write it to an environment file.

## Provider-Specific Environments

The checked-in toolchain and Compose definitions above are canonical. Older
VM snapshots can have different PATH ordering, Docker privileges, or secrets;
verify those capabilities before following snapshot-specific notes.

### Cursor Cloud VM

Earlier snapshots supplied Node, pnpm, uv, and Docker but ran only
`pnpm install` during updates. Services needed starting separately, and the
Infisical CLI was absent. These are recorded snapshot observations, not
promises about every Cursor environment. Use the versions declared by
[`package.json`](../package.json) and [`mise.toml`](../mise.toml) rather than
copying historical version numbers.

If an inherited `/exec-daemon/node` takes precedence over the required Node
version, use `mise exec -- <command>` with the locked toolchain; see
[mise environment activation](https://mise.jdx.dev/cli/exec.html).
The analytics commands use uv, so their first run may need package downloads.

On a VM without systemd, start its Docker daemon through the VM's supported
service mechanism, or run `sudo dockerd` with logs redirected to a file, then
check `docker info` before starting Compose. Diagnose socket ownership and
group membership if access is denied; follow Docker's
[Linux post-installation instructions](https://docs.docker.com/engine/install/linux-postinstall/)
rather than making the daemon socket world-writable. Docker documents
[manual daemon startup](https://docs.docker.com/engine/daemon/start/).

Full initialization requires Infisical authentication. Install the locked CLI
and authenticate before `mise run cloud:init`; the
[environment wrapper](../scripts/with-env.ts) deliberately fails when export
is unavailable. Existing local services can provide non-secret URLs through
`.env.local`, but this does not replace provider credentials or make
secret-gated commands available. After database setup, export the local URLs
and run the [seed command](../scripts/seed-dev-db.ts):

```bash
set -a
. ./.env.local
set +a
pnpm seed
```

Then start the API and web client using [the README commands](../README.md).
Visit `/auth/dev-login` through the web client to use the seeded `dev-session`;
[the server route](../packages/server/src/index.ts) sets the session cookie and
redirects to the dashboard. It is enabled outside production (or with the
explicit preview configuration). Provider OAuth credentials are still required
for real provider authentication.

### Codex Cloud Without Docker Privileges

The repository previously observed a cloud container where Docker startup
failed because user namespace creation was blocked. Treat that as a capability
of that container, not a general OpenAI platform restriction. When the current
environment has this limitation, use:

```bash
SANDBOX=1 mise run cloud:init
mise run test:sandbox
```

[`scripts/dev-environment.ts`](../scripts/dev-environment.ts) makes
`SANDBOX=1` skip only the Docker-backed startup phase. Prebuild still installs
dependencies and initializes CodeGraph/RTK. The
[`test:sandbox` task](../mise.toml) runs each declared package typecheck,
`pnpm lint:sandbox`, and Docker-free unit/mobile tests.
`lint:sandbox` omits `lint:analytics-sql`, which needs uv and ClickHouse; see
[the script definitions](../package.json).

Database-backed integration, Compose, web E2E, and the full environment doctor
require unavailable services in that environment. Record which checks were not
run locally and use the [CI integration tier](testing.md#integration-dependencies)
for real-engine validation.

For the legacy setup-script environment, OpenAI's [cloud environment documentation](https://developers.openai.com/codex/cloud/environments)
describes setup-only secrets: they are removed before the agent phase. Arrange
required setup artifacts during setup without printing or committing secrets;
commands that require unavailable credentials must still fail explicitly.

## Included Toolchain

Portable tool versions live in `mise.toml`; the lockfile is their installation
record. System packages and vcpkg are pinned by the Dev Container Dockerfile.
Together, the toolchain includes:

| Area | Tools |
|---|---|
| JavaScript | Node.js, pnpm |
| Python and analytics | Python 3.12, uv |
| Secrets and repository access | Infisical CLI, GitHub CLI, jq |
| Native FIT decoder | CMake, Ninja, vcpkg, C/C++ compiler |
| Agent navigation | CodeGraph |
| Agent command compression | RTK |
| Services | Docker Engine, Docker Compose |

CodeGraph is installed from its pinned GitHub release and initialized per
workspace. The repository MCP definition launches
`mise exec -- codegraph serve --mcp`, matching CodeGraph's
[documented MCP integration](https://colbymchenry.github.io/codegraph/reference/integrations/).

RTK is installed from its pinned, checksum-verified GitHub release. The Dev
Container additionally runs:

```bash
mise run agent:codex
```

This applies RTK's Codex instructions inside the disposable cloud user
environment. Local users can opt into the same global integration explicitly;
ordinary repository initialization does not mutate their global Codex
configuration.

## Shared Agent Skills

Repository skills live in `.agents/skills/<name>/SKILL.md`. Each skill uses
YAML metadata with `name` and `description`, followed by Markdown
instructions; scripts, references, and assets stay beside that file, following
the [Agent Skills specification](https://agentskills.io/specification).

[Codex](https://learn.chatgpt.com/docs/build-skills#where-to-save-skills),
[Cursor](https://cursor.com/docs/skills#skill-directories),
[Gemini CLI](https://geminicli.com/docs/cli/skills/#discovery-tiers), and
[OpenCode](https://opencode.ai/docs/skills/#discovery) document discovery from
`.agents/skills`. The repository's `.claude/skills` symlink points to
`../.agents/skills`, exposing the same files through
[Claude Code's project skill location](https://code.claude.com/docs/en/skills#choose-where-skills-load).

Keep shared instructions explicit: describe how to obtain inputs from the
request and which commands to run. Claude Code's
[argument substitutions and command injection](https://code.claude.com/docs/en/skills#available-string-substitutions)
are harness features, rather than part of the shared skill format.

## Commands

```bash
# Tools, pnpm dependencies, CodeGraph, and RTK; no secrets or Docker required
mise run cloud:prebuild

# Docker services, database setup, and final verification
mise run cloud:start

# Both phases
mise run cloud:init

# Read-only verification
mise run doctor

# Enable RTK's Codex instructions in the current user environment
mise run agent:codex
```

All Compose operations still pass through `pnpm compose --`, which assigns a
physical-workspace project name and directory. Docker documents these
isolation mechanisms in
[Compose project names](https://docs.docker.com/compose/how-tos/project-name/)
and the
[`--project-directory` option](https://docs.docker.com/reference/cli/docker/compose/).

## Platform Boundaries

| Environment | Supported scope |
|---|---|
| Linux Dev Container/cloud | Web, server, providers, analytics, databases, native FIT decoder, unit and integration tests |
| macOS | The Linux-equivalent toolchain plus native iOS work when Xcode is installed |
| Linux without privileged Docker | Tool installation and Docker-free tests through `SANDBOX=1`; database-backed startup is unavailable |

Xcode, iOS Simulator runtimes, signing identities, CocoaPods, SwiftLint,
Periphery, and MutantKit remain a macOS-native profile. The configured MutantKit
artifact targets macOS ARM64 and is checksum/provenance-pinned through the
[GitHub backend](https://mise.jdx.dev/dev-tools/backends/github.html) in
[mise.toml](../mise.toml) and [mise.lock](../mise.lock); see the
[native mutation procedure](testing.md#native-swift-mutation-testing).
Apple distributes and
supports Xcode through its
[Xcode resources](https://developer.apple.com/xcode/resources/); a Linux
container cannot replace that platform requirement.

## Conductor

The shared [Conductor settings](../.conductor/settings.toml) install the locked
toolchain and run `cloud:prebuild` without relying on interactive shell startup.
The local web command executes through mise and uses Conductor's allocated
workspace port. Cloud workspaces also expose `cloud-init`, while both local and
cloud workspaces expose `doctor`.

Conductor reads shared repository settings from the default branch, so these
commands become the project defaults after the settings change is merged.
Conductor documents this setup and run-script model in its
[script reference](https://www.conductor.build/docs/reference/scripts).

Local Conductor users must install mise and activate it in their login shell so
the `rtk` shim is available to agent terminal commands. CodeGraph MCP does not
depend on shell activation because `.mcp.json` launches it through
`mise exec`.

## Storybook through a development tunnel

Web and mobile Storybook allow `.trycloudflare.com` hosts so a Cloudflare quick
tunnel can forward its public hostname. Host validation stays enabled for other
public domains. Storybook configures this reverse-proxy access through
[`core.allowedHosts`](https://storybook.js.org/docs/api/main-config/main-config-core#allowedhosts).
Start the usual Storybook command, then run `paseo-quick-tunnel <port>` if that
helper is installed on your workstation; keep the tunnel running while reviewing
the UI. Cloudflare describes the generated public hostname and tunnel lifetime
in its [quick tunnel guide](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
