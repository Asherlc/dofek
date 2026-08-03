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
4. Fails immediately if the Docker daemon is unavailable.
5. Starts the canonical workspace-isolated Compose services.
6. Applies the Postgres and ClickHouse migrations with Infisical secrets.
7. Runs the complete environment doctor.

mise tasks run with the tools and environment declared in `mise.toml`; see the
[mise task documentation](https://mise.jdx.dev/tasks/).

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
| Linux without privileged Docker | Tool installation and Docker-free unit tests only; `cloud:start` fails before database setup |

Xcode, iOS Simulator runtimes, signing identities, CocoaPods, SwiftLint,
Periphery, and Muter remain a macOS-native profile. Apple distributes and
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
