# Management UI Auth

Production and staging management UIs are protected by Authentik through
Traefik forward auth:

- Portainer
- Databasus
- CloudBeaver
- pgAdmin
- Netdata

The Dofek stack runs a local Authentik proxy outpost service named
`authentik-proxy`. Management routers use the shared Traefik middleware
`management-auth`, which calls:

```text
http://authentik-proxy:9000/outpost.goauthentik.io/auth/traefik
```

The local outpost is required because forwarding auth checks to the public
`https://authentik.asherlc.com` hostname loses the original protected host and
causes Authentik to return users to the Authentik dashboard instead of the
requested management UI.

## Required Secret

`AUTHENTIK_OUTPOST_TOKEN` must exist in each Infisical environment that deploys
the web stack:

- `prod`
- `staging`

The token comes from the Authentik proxy outpost deployment info. It must never
be committed. The stack fails before deploy if the key is absent.

The outpost image is pinned to the current Authentik core version
`2025.2.4`. Upgrade the Authentik core server and this image together.

## Validation

For every protected management host, the outpost ping endpoint must return
HTTP 204:

```bash
for host in \
  portainer.dofek.asherlc.com \
  databasus.dofek.asherlc.com \
  cloudbeaver.dofek.asherlc.com \
  pgadmin.dofek.asherlc.com \
  netdata.dofek.asherlc.com
do
  curl -sk -o /dev/null -w "$host %{http_code}\n" \
    "https://$host/outpost.goauthentik.io/ping"
done
```

If a host returns `302`, the `/outpost.goauthentik.io/` router is not reaching
the local outpost. If a host returns `404`, check the host-specific Traefik
rule and DNS record before debugging Authentik.
