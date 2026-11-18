# Dofek Actions dashboard

Pipedash provides a focused view of Dofek's GitHub Actions runs at the configured
hostname `https://pipedash.dofek.fit`. It uses the existing production Traefik
proxy and the canonical Dofek Swarm release workflow.

The stack pins the published, multi-platform Pipedash **0.14.0** image by digest.
The upstream [release](https://github.com/hcavarsan/pipedash/releases/tag/v0.14.0),
[container build](https://github.com/hcavarsan/pipedash/blob/v0.14.0/docker/Dockerfile)
and [Docker deployment guide](https://pipedash.app/docs/deployment/docker)
describe the image, its unprivileged `65532:65532` user and writable `/data` volume.
No custom image or separate database is needed.

## Configuration and credentials

[`config.toml`](config.toml) selects only `Asherlc/dofek`, refreshes every 60
seconds and disables public status pages. It is mounted as the versioned Docker
Swarm config `pipedash_config_v1`. Change the checked-in configuration through
the normal release process and rotate that config name when its contents change;
[Swarm configs are immutable](https://docs.docker.com/engine/swarm/configs/).

Both required credentials belong in the existing Infisical project's `prod`
environment:

- `PIPEDASH_VAULT_PASSWORD`: a strong, stable password. Pipedash uses it both to
  encrypt stored tokens and to authenticate API/browser access. Retrieve it
  through Infisical when signing in; changing it is a credential-rotation
  operation, not a routine restart.
- `PIPEDASH_GITHUB_TOKEN`: a dedicated fine-grained GitHub token restricted to
  `Asherlc/dofek`, with **Actions: read and write** and **Contents: read-only**.
  GitHub includes required metadata access automatically. Record its expiration
  and rotate it in Infisical before expiry. Do not reuse a workstation login or
  registry credential.

GitHub documents the [Actions write permission for manual dispatch](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
and [Contents read permission for workflow source](https://docs.github.com/en/rest/repos/contents#get-repository-content).
Pipedash's versioned [API authentication](https://github.com/hcavarsan/pipedash/blob/v0.14.0/crates/pipedash-web/src/lib.rs)
and [vault implementation](https://github.com/hcavarsan/pipedash/blob/v0.14.0/crates/pipedash-web/src/routes/vault.rs)
define the password/bearer behavior. The server receives neither the rest of the
application environment nor other deployment credentials: the existing service
environment renderer writes only these two keys into its private `pipedash.env`.
Missing credentials fail before stack changes.

## Persistence and upgrades

The named `pipedash_data` volume holds SQLite state, encrypted provider tokens,
saved views and preferences. It survives container replacement and normal stack
deployments. Keep it when removing or recreating a service. Docker documents
[named-volume persistence and initial content/permission copying](https://docs.docker.com/engine/storage/volumes/).

The service runs one replica and uses `stop-first` updates so one Pipedash
process owns the SQLite store at a time. A dashboard upgrade can briefly
interrupt its UI. It does not change Dofek's web/worker release behavior.

For an upgrade, verify the latest stable release and ARM64 image manifest,
update its version and digest together, and validate the released container
before deploying. Preserve the vault password and volume. If an upgrade changes
Pipedash's own stored schema, follow its release guidance before rolling back an
image; replacing a container does not undo database changes.

## Release and verification

Apply the checked-in DNS and stack through the standard
[production release procedure](../README.md#flow-diagram). Use the existing
`web` release target when infrastructure must be applied. Do not run a separate
manual stack deploy or change the live service over SSH.

The image is built from `scratch` and has no shell or HTTP client. Traefik probes
its native `/api/v1/health` endpoint; the canonical release also waits for the
service and checks all three conditions over the public TLS route:

- `/api/v1/health` returns HTTP 200.
- An anonymous `/api/v1/providers` request returns HTTP 401.
- The same request with the vault password as a bearer token returns HTTP 200.

These endpoint contracts come from the tagged
[health route](https://github.com/hcavarsan/pipedash/blob/v0.14.0/crates/pipedash-web/src/routes/health.rs)
and [API authentication middleware](https://github.com/hcavarsan/pipedash/blob/v0.14.0/crates/pipedash-web/src/lib.rs).
They verify the dashboard service and access controls. Separately confirm that
the GitHub provider can actually fetch Dofek workflows; a healthy dashboard can
still have an expired or incorrectly scoped provider token.

## Focused navigation

After the provider has loaded Dofek workflows, use Pipedash's native saved views
and pins to expose the workflows needed for daily work:

- Pin **CI** and **Release / Production** in a small **Dofek** view.
- Keep package publication in a separate **Packages** view and operational
  workflows in **Maintenance**.
- Open the focused view directly when bookmarking the dashboard. The full list
  remains available for investigation without crowding daily navigation.

Use the built-in [view controls](https://pipedash.app/docs/features/views);
there is no repository-specific dashboard or seeding framework. Views live in
the persistent SQLite store, independently of the read-only provider config.
If the volume is lost, restore it or recreate these views after reconnecting the
provider with the same Infisical credentials.
