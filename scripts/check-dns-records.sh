#!/usr/bin/env bash
# Verify every domain in Traefik Host() rules has a matching DNS record in Terraform.
# Catches drift where a domain is added to docker-compose but not to dns.tf.
set -euo pipefail

COMPOSE="deploy/docker-compose.deploy.yml"
DNS_TF="deploy/dns.tf"

# Extract all hostnames from Traefik Host(`...`) labels (portable, no -P flag)
hosts=$(sed -n 's/.*Host(`\([^`]*\)`).*/\1/p' "$COMPOSE" | tr '|' '\n' | sed -n 's/.*Host(`\([^`]*\)`).*/\1/p; s/^[[:space:]]*//p' | sort -u)
# The compose file uses || between Host() rules on a single line, so also split those
hosts=$(grep -o 'Host(`[^`]*`)' "$COMPOSE" | sed 's/Host(`//;s/`)//' | sort -u)

missing=()
for host in $hosts; do
  # Check dns.tf has a record whose name matches this host (literal string or via zone reference)
  # For bare domains like "dofek.fit", the name field is just "dofek.fit"
  # For subdomains like "dofek.asherlc.com", the name field is "dofek.asherlc.com"
  if ! grep -q "\"$host\"" "$DNS_TF"; then
    missing+=("$host")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "ERROR: The following Traefik domains have no matching DNS record in $DNS_TF:"
  for host in "${missing[@]}"; do
    echo "  - $host"
  done
  echo ""
  echo "Add a cloudflare_dns_record for each missing domain to prevent 521 errors."
  exit 1
fi

echo "All Traefik domains have matching DNS records."
