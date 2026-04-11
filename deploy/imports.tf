# One-time imports for existing resources into the unified workspace.
# Remove this file after the first successful `terraform apply`.

# ── Hetzner ──────────────────────────────────────────────────────────────

import {
  to = hcloud_server.dofek
  id = "123680458"
}

import {
  to = hcloud_firewall.dofek
  id = "10697137"
}

import {
  to = hcloud_ssh_key.default
  id = "109069629"
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

# ── Cloudflare DNS Records (dofek.fit) ───────────────────────────────────

import {
  to = cloudflare_dns_record.dofek_fit_root
  id = "e84824ec752ae0ff479c92619ec950cc"
}

import {
  to = cloudflare_dns_record.dofek_fit_www
  id = "f0f102e4ea49da103b8685ee3ea0e687"
}

import {
  to = cloudflare_dns_record.dofek_fit_preview_wildcard
  id = "424bedb3215b3ae375717ad639693ce2"
}

# ── Cloudflare DNS Records (dofek.live) ──────────────────────────────────

import {
  to = cloudflare_dns_record.dofek_live_root
  id = "1b0d9221fdffbe5e96a690d55b602d55"
}

import {
  to = cloudflare_dns_record.dofek_live_www
  id = "16dee731c6f278ac9ee3e4ac3a3f8f3a"
}

# ── Cloudflare DNS Records (asherlc.com) ─────────────────────────────────

import {
  to = cloudflare_dns_record.ota_dofek_asherlc
  id = "e5155b8f3ab1f1eadf1f596d8545db8d"
}

# ── Cloudflare R2 Buckets ────────────────────────────────────────────────

import {
  to = cloudflare_r2_bucket.training_data
  id = "dofek-training-data"
}

import {
  to = cloudflare_r2_bucket.ota
  id = "dofek-ota"
}

import {
  to = cloudflare_r2_bucket.storybook
  id = "dofek-storybook"
}

# ── Cloudflare R2 Custom Domain ──────────────────────────────────────────

import {
  to = cloudflare_r2_custom_domain.storybook_preview
  id = "storybook.dofek.fit"
}

# ── PostgreSQL ───────────────────────────────────────────────────────────

import {
  to = postgresql_extension.timescaledb
  id = "timescaledb"
}
