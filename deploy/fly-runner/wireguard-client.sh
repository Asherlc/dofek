#!/usr/bin/env bash
# Portable-runner side: rootless userspace WireGuard via wireproxy.
set -euo pipefail

# Fail closed with the missing name only; never print the value of a secret.
: "${SYNC_WIREGUARD_PRIVATE_KEY:?SYNC_WIREGUARD_PRIVATE_KEY is required}"
: "${SYNC_WIREGUARD_PEER_PUBLIC_KEY:?SYNC_WIREGUARD_PEER_PUBLIC_KEY is required}"
: "${SYNC_WIREGUARD_ENDPOINT:?SYNC_WIREGUARD_ENDPOINT is required}"

wg_key_pattern='^[A-Za-z0-9+/]{43}=$'
if [[ ! $SYNC_WIREGUARD_PRIVATE_KEY =~ $wg_key_pattern ]]; then
  echo 'SYNC_WIREGUARD_PRIVATE_KEY must be a 32-byte base64 WireGuard key' >&2
  exit 1
fi
if [[ ! $SYNC_WIREGUARD_PEER_PUBLIC_KEY =~ $wg_key_pattern ]]; then
  echo 'SYNC_WIREGUARD_PEER_PUBLIC_KEY must be a 32-byte base64 WireGuard key' >&2
  exit 1
fi

endpoint_pattern='^([[:alnum:].-]+|\[[[:xdigit:]:.]+\]):[0-9]+$'
if [[ ! $SYNC_WIREGUARD_ENDPOINT =~ $endpoint_pattern ]]; then
  echo 'SYNC_WIREGUARD_ENDPOINT must be host:port or [IPv6]:port' >&2
  exit 1
fi

proxy_pid=''
worker_pid=''

cleanup() {
  # Do not call exit or overwrite $?; Bash preserves the triggering status.
  if [ -n "${proxy_pid:-}" ] && kill -0 "$proxy_pid" 2>/dev/null; then
    kill -TERM "$proxy_pid" 2>/dev/null || true
    wait "$proxy_pid" 2>/dev/null || true
  fi
}

on_signal() {
  if [ -z "${worker_pid:-}" ]; then
    # Startup interrupted before the worker launched.
    exit 0
  fi
  # Normal drain: signal only the worker; keep the proxy alive for Redis waits.
  kill -TERM "$worker_pid" 2>/dev/null || true
}

# Feed peer config over stdin so no private material appears in argv or a file.
# -s suppresses verbose tunnel logs; fatal errors still surface on stderr.
# Bind only the three Oracle gateway services on loopback.
wireproxy -s -c /dev/stdin <<EOF &
[Interface]
Address = 10.253.0.2/32
PrivateKey = ${SYNC_WIREGUARD_PRIVATE_KEY}

[Peer]
PublicKey = ${SYNC_WIREGUARD_PEER_PUBLIC_KEY}
Endpoint = ${SYNC_WIREGUARD_ENDPOINT}
AllowedIPs = 10.253.0.1/32
PersistentKeepalive = 25

[TCPClientTunnel]
BindAddress = 127.0.0.1:5432
Target = 10.253.0.1:5432

[TCPClientTunnel]
BindAddress = 127.0.0.1:6379
Target = 10.253.0.1:6379

[TCPClientTunnel]
BindAddress = 127.0.0.1:4318
Target = 10.253.0.1:4318
EOF
proxy_pid=$!

# Reap the proxy on any exit path; TERM/INT before the startup wait.
trap cleanup EXIT
trap on_signal TERM INT

# Drop tunnel credentials before the worker starts.
unset SYNC_WIREGUARD_PRIVATE_KEY SYNC_WIREGUARD_PEER_PUBLIC_KEY SYNC_WIREGUARD_ENDPOINT

# Bounded startup wait within Fly's 15s grace: poll Postgres listen readiness.
SECONDS=0
while ! (: >/dev/tcp/127.0.0.1/5432) 2>/dev/null; do
  if ! kill -0 "$proxy_pid" 2>/dev/null; then
    wait "$proxy_pid" || true
    echo 'Wireproxy exited before the local tunnels were ready' >&2
    exit 1
  fi
  if (( SECONDS >= 5 )); then
    echo 'Timed out waiting for the local Postgres WireGuard tunnel' >&2
    exit 1
  fi
  sleep 0.1
done

/app/entrypoint.sh portable-sync-worker &
worker_pid=$!

while true; do
  unset finished_pid
  status=0
  # Under set -e, a failing or signal-interrupted wait must not exit the shell
  # before status is captured.
  wait -n -p finished_pid "$proxy_pid" "$worker_pid" || status=$?

  # A signal can interrupt wait before either child exits; keep listening.
  if [ -z "${finished_pid:-}" ]; then
    continue
  fi

  if [ "$finished_pid" = "$proxy_pid" ]; then
    echo 'Wireproxy exited while the portable sync worker was still running' >&2
    # Data path is gone: kill and reap the worker immediately.
    if [ -n "${worker_pid:-}" ] && kill -0 "$worker_pid" 2>/dev/null; then
      kill -KILL "$worker_pid" 2>/dev/null || true
      wait "$worker_pid" 2>/dev/null || true
    fi
    exit 1
  fi

  # Worker finished: EXIT cleanup reaps the proxy; status propagates via $?.
  exit "$status"
done
