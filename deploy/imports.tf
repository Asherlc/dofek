# One-time imports for existing resources into the unified workspace.
# Remove this file after the first successful `terraform apply`.

# ── Hetzner ──────────────────────────────────────────────────────────────

import {
  to = hcloud_server.dofek
  id = "125992620"
}

import {
  to = hcloud_firewall.dofek
  id = "10697137"
}

import {
  to = hcloud_ssh_key.default
  id = "110391979"
}

# ── Cloudflare Zones ─────────────────────────────────────────────────────

import {
  to = cloudflare_zone.dofek_fit
  id = "a744a251a98f2cbffef47d0e3054e084"
}

import {
  to = cloudflare_zone.dofek_live
  id = "04dc9fc04f990bdb6c509fd51b13688f"
}

# ── Cloudflare DNS Records ──────────────────────────────────────────────
# Format: <zone_id>/<record_id>

import {
  to = cloudflare_dns_record.dofek_fit_root
  id = "a744a251a98f2cbffef47d0e3054e084/e84824ec752ae0ff479c92619ec950cc"
}

import {
  to = cloudflare_dns_record.dofek_fit_www
  id = "a744a251a98f2cbffef47d0e3054e084/f0f102e4ea49da103b8685ee3ea0e687"
}

import {
  to = cloudflare_dns_record.dofek_fit_preview_wildcard
  id = "a744a251a98f2cbffef47d0e3054e084/424bedb3215b3ae375717ad639693ce2"
}

import {
  to = cloudflare_dns_record.dofek_live_root
  id = "04dc9fc04f990bdb6c509fd51b13688f/1b0d9221fdffbe5e96a690d55b602d55"
}

import {
  to = cloudflare_dns_record.dofek_live_www
  id = "04dc9fc04f990bdb6c509fd51b13688f/16dee731c6f278ac9ee3e4ac3a3f8f3a"
}

import {
  to = cloudflare_dns_record.dofek_asherlc
  id = "17402b9a561d3ec6671998afa3439b68/54b62c7fe9c9e60cd5727620a852cce4"
}

import {
  to = cloudflare_dns_record.ota_dofek_asherlc
  id = "17402b9a561d3ec6671998afa3439b68/e5155b8f3ab1f1eadf1f596d8545db8d"
}

# ── Cloudflare R2 Buckets ────────────────────────────────────────────────
# Format: <account_id>/<bucket_name>/default

import {
  to = cloudflare_r2_bucket.training_data
  id = "8e5b2f62ffe8ebdd48e725d325a6d51e/dofek-training-data/default"
}

import {
  to = cloudflare_r2_bucket.ota
  id = "8e5b2f62ffe8ebdd48e725d325a6d51e/dofek-ota/default"
}

import {
  to = cloudflare_r2_bucket.storybook
  id = "8e5b2f62ffe8ebdd48e725d325a6d51e/dofek-storybook/default"
}

# ── Cloudflare R2 Custom Domain ──────────────────────────────────────────
# cloudflare_r2_custom_domain does not support import and has been removed
# from configuration (deploy/storage.tf). Managed manually in Cloudflare.
