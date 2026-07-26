# Traefik Route 404 Runbook

Use this when an active production route returns Traefik's:

```text
404 page not found
```

The active Oracle production routes are the main application hosts, the OTA
host, and Databasus, which remains enabled because it owns the PostgreSQL backup
schedule. Portainer, Netdata, CloudBeaver, pgAdmin, and PeerDB UI are defined in
the base stack but intentionally scaled to zero by `deploy/stack.oracle.yml`;
their historical hostnames are not expected to work.

## 1. Confirm the Failure Shape

Check the affected host and a known application host:

```bash
curl -sSI https://ota.dofek.asherlc.com/ | sed -n '1,8p'
curl -sSI https://dofek.asherlc.com/ | sed -n '1,8p'
```

Traefik's plain `404 page not found` usually means no active router matched the
request. A response from the application, a TLS failure, or a DNS failure is a
different failure class.

## 2. Check Swarm State

```bash
docker --context prod service ls --format 'table {{.Name}}\t{{.Replicas}}'
docker --context prod service ps dofek_traefik --no-trunc
docker --context prod service ps dofek_web --no-trunc
docker --context prod service ps dofek_ota --no-trunc
docker --context prod service ps dofek_databasus --no-trunc
```

Record the first failed task and its error. Do not redeploy before distinguishing
a missing router from an unhealthy upstream.

## 3. Check Traefik Evidence

```bash
docker --context prod service logs --since 30m dofek_traefik 2>&1 | \
  rg -i 'error|router|provider|middleware|dofek|ota|databasus'
```

Inspect the deployed service labels rather than assuming the checked-in labels
reached production:

```bash
docker --context prod service inspect dofek_web \
  --format '{{json .Spec.Labels}}'
docker --context prod service inspect dofek_ota \
  --format '{{json .Spec.Labels}}'
docker --context prod service inspect dofek_databasus \
  --format '{{json .Spec.Labels}}'
```

Then compare them with the canonical base-stack rules:

```bash
rg -n 'traefik.http.routers.(web|ota|databasus)|loadbalancer.server.port' \
  deploy/stack.yml
```

Verify:

- `traefik.enable=true`;
- the `Host(...)` rule contains the requested host;
- the router uses the `websecure` entrypoint with TLS;
- the service port matches the listening application port;
- Traefik's swarm provider is healthy and reading the same Docker daemon.

Traefik documents that routers match requests through rules and entrypoints,
and that Docker/Swarm labels define dynamic routing configuration:
<https://doc.traefik.io/traefik/routing/routers/> and
<https://doc.traefik.io/traefik/providers/swarm/>.

## 4. Apply the Canonical Fix

Fix the root cause in the checked-in stack, workflow inputs, DNS configuration,
or failing service. Production deploys must use the repository workflow because
it applies the Oracle override, renders Infisical secrets, gates migrations and
CDC, and verifies rollout health.

After the fix passes CI, let the normal `main` workflow deploy it or dispatch
the same workflow deliberately:

```bash
gh workflow run deploy-web.yml \
  --ref '<branch-or-tag-at-exact-image-commit>' \
  -f environment=production \
  -f image_tag='<validated-image-tag>'
```

The source ref must resolve exactly to the commit encoded by the image's
`SENTRY_RELEASE`, not merely contain that commit; see the
[`gh workflow run` reference](https://cli.github.com/manual/gh_workflow_run).

Do not run a direct `docker stack deploy -c deploy/stack.yml`: that omits
`deploy/stack.oracle.yml` and the production release gates.

## 5. Verify

```bash
curl -fsSI https://dofek.asherlc.com/ | sed -n '1,8p'
curl -fsSI https://ota.dofek.asherlc.com/ | sed -n '1,8p'
curl -sSI https://databasus.dofek.asherlc.com/ | sed -n '1,8p'
docker --context prod service inspect dofek_traefik --pretty
docker --context prod service inspect dofek_web --pretty
docker --context prod service inspect dofek_ota --pretty
docker --context prod service inspect dofek_databasus --pretty
```

If the route still fails, preserve the request output, deployed labels,
Traefik logs, task errors, workflow run, image tag, and first fatal line before
continuing the investigation.
