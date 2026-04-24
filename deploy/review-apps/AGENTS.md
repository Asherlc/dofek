# Review App Agent Instructions

> **Read the [README.md](./README.md) first** before changing review-app infra.

## Guardrails

- Use the existing shared front door on `dofek.asherlc.com`; do not create a
  second wildcard ingress path for review apps.
- Keep review apps minimal. The intended stack is `web`, `db`, and `redis`
  unless the user explicitly asks for broader production parity.
- Every change to front door routing must remain specific to
  `pr-<number>.dofek.asherlc.com` and must not widen into a catch-all wildcard
  HTTP router that could overlap management hosts.
- Destroy flows must remove both the Hetzner server and the corresponding
  Traefik dynamic route file.
