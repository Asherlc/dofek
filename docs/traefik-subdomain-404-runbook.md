# Traefik Subdomain 404 Runbook

Use this when a domain like `portainer.dofek.asherlc.com` returns:

```text
404 page not found
```

That response usually means Traefik has no active router for that host.

## Scope

This runbook is for management subdomains routed by Traefik in `deploy/stack.yml`:

- `portainer.dofek.asherlc.com`
- `netdata.dofek.asherlc.com`
- `databasus.dofek.asherlc.com`
- `pgadmin.dofek.asherlc.com`
- `ota.dofek.asherlc.com`

## 1. Confirm the failure shape

From your machine:

```bash
curl -sSI https://portainer.dofek.asherlc.com/ | sed -n '1,8p'
curl -sS https://portainer.dofek.asherlc.com/ | head -n 1
```

Expected failure pattern:
- Status `HTTP/2 404`
- Body `404 page not found`

Compare with a known good host:

```bash
curl -sSI https://dofek.asherlc.com/ | sed -n '1,8p'
```

If `dofek.asherlc.com` is healthy and only management subdomains fail, continue.

## 2. Check swarm service state

```bash
docker --context prod service ls --format 'table {{.Name}}\t{{.Replicas}}'
docker --context prod service ps dofek_traefik
docker --context prod service ps dofek_portainer
docker --context prod service ps dofek_netdata
docker --context prod service ps dofek_databasus
docker --context prod service ps dofek_pgadmin
docker --context prod service ps dofek_ota
```

If any target service is `0/1` or repeatedly restarting, Traefik may not have an upstream to route to.

## 3. Check Traefik logs for router/provider errors

```bash
docker --context prod service logs --since 30m dofek_traefik 2>&1 | \
  rg -i 'error|router|middleware|portainer|netdata|databasus|pgadmin|ota'
```

Common issue patterns:
- Middleware reference errors
- Invalid label syntax
- Provider refresh failures

## 4. Verify route labels in stack config

Check `deploy/stack.yml` labels for the failing service:

```bash
rg -n 'traefik.http.routers.(portainer|netdata|databasus|pgadmin|ota)|middlewares|loadbalancer.server.port' deploy/stack.yml
```

Focus on:
- `traefik.enable=true`
- `traefik.http.routers.<name>.rule=Host(...)`
- `traefik.http.routers.<name>.entrypoints=websecure`
- `traefik.http.routers.<name>.tls=true`
- `traefik.http.services.<name>.loadbalancer.server.port=<port>`
- Middleware names that must exist in the same provider scope

## 5. Redeploy stack after fix

```bash
docker --context prod stack deploy -c deploy/stack.yml --with-registry-auth --prune dofek
```

Then verify:

```bash
for host in \
  portainer.dofek.asherlc.com \
  netdata.dofek.asherlc.com \
  databasus.dofek.asherlc.com \
  pgadmin.dofek.asherlc.com \
  ota.dofek.asherlc.com
do
  echo "== $host =="
  curl -sSI "https://$host/" | sed -n '1,8p'
done
```

## 6. If still 404

Collect these outputs before deeper debugging:

```bash
docker --context prod service inspect dofek_traefik --pretty
docker --context prod service inspect dofek_portainer --pretty
docker --context prod service inspect dofek_netdata --pretty
docker --context prod service inspect dofek_databasus --pretty
docker --context prod service inspect dofek_pgadmin --pretty
docker --context prod service inspect dofek_ota --pretty
```

At that point, you should have enough evidence to identify whether the issue is:
- service health/startup failure
- Traefik label/router config failure
- middleware lookup/scope mismatch
