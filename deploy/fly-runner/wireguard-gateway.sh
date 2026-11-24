#!/bin/sh
# Oracle-side authenticated gateway: kernel WireGuard and TCP relay.
set -eu

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# Fail closed with the missing name only; never print the value of a secret.
: "${SYNC_WIREGUARD_PRIVATE_KEY:?SYNC_WIREGUARD_PRIVATE_KEY is required}"
: "${SYNC_WIREGUARD_PEER_PUBLIC_KEY:?SYNC_WIREGUARD_PEER_PUBLIC_KEY is required}"

ip link add dofekwg type wireguard
ip -4 address add 10.253.0.1/30 dev dofekwg

# Feed both keys over stdin so no private material appears in argv or a file.
# Only the single peer /32 is allowed; no other subnets are routed.
printf '%s\n' \
  '[Interface]' \
  "PrivateKey = $SYNC_WIREGUARD_PRIVATE_KEY" \
  'ListenPort = 51820' \
  '' \
  '[Peer]' \
  "PublicKey = $SYNC_WIREGUARD_PEER_PUBLIC_KEY" \
  'AllowedIPs = 10.253.0.2/32' |
  wg setconf dofekwg /dev/stdin 2>/dev/null || {
    echo 'Failed to configure the WireGuard gateway; check the configured keys' >&2
    exit 1
  }

# MTU 1200 matches the wireproxy peer and leaves room for WireGuard encapsulation
# on this constrained Fly-to-Oracle path (default 1420 drops large Redis writes).
ip link set dev dofekwg mtu 1200 up

# The relay needs no credentials after setup.
unset SYNC_WIREGUARD_PRIVATE_KEY SYNC_WIREGUARD_PEER_PUBLIC_KEY

exec haproxy -db -f "$script_dir/haproxy.cfg"
