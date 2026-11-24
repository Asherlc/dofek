#!/bin/sh
# Portable-runner side: kernel WireGuard to the Oracle gateway.
set -eu

# Fail closed with the missing name only; never print the value of a secret.
: "${SYNC_WIREGUARD_PRIVATE_KEY:?SYNC_WIREGUARD_PRIVATE_KEY is required}"
: "${SYNC_WIREGUARD_PEER_PUBLIC_KEY:?SYNC_WIREGUARD_PEER_PUBLIC_KEY is required}"
: "${SYNC_WIREGUARD_ENDPOINT:?SYNC_WIREGUARD_ENDPOINT is required}"

case "$SYNC_WIREGUARD_ENDPOINT" in
  *:*) ;;
  *)
    echo 'SYNC_WIREGUARD_ENDPOINT must be host:port' >&2
    exit 1
    ;;
esac

ip link add dofekwg type wireguard
ip -4 address add 10.253.0.2/30 dev dofekwg

# Feed both keys over stdin so no private material appears in argv or a file.
# Only the gateway /32 is allowed; no other subnets are routed.
printf '%s\n' \
  '[Interface]' \
  "PrivateKey = $SYNC_WIREGUARD_PRIVATE_KEY" \
  '' \
  '[Peer]' \
  "PublicKey = $SYNC_WIREGUARD_PEER_PUBLIC_KEY" \
  "Endpoint = $SYNC_WIREGUARD_ENDPOINT" \
  'AllowedIPs = 10.253.0.1/32' \
  'PersistentKeepalive = 25' |
  wg setconf dofekwg /dev/stdin 2>/dev/null || {
    echo 'Failed to configure the WireGuard client; check the configured keys and endpoint' >&2
    exit 1
  }

ip link set dofekwg up

# The worker must not inherit tunnel credentials or the endpoint.
unset SYNC_WIREGUARD_PRIVATE_KEY SYNC_WIREGUARD_PEER_PUBLIC_KEY SYNC_WIREGUARD_ENDPOINT
exec su-exec 1000:1000 /app/entrypoint.sh portable-sync-worker
