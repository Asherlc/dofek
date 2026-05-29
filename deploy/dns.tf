# --- dofek.fit ---

resource "cloudflare_zone" "dofek_fit" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "dofek.fit"
}

resource "cloudflare_dns_record" "dofek_fit_root" {
  zone_id = cloudflare_zone.dofek_fit.id
  type    = "A"
  name    = "dofek.fit"
  content = var.oracle_server_host
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "dofek_fit_www" {
  zone_id = cloudflare_zone.dofek_fit.id
  type    = "CNAME"
  name    = "www.dofek.fit"
  content = "dofek.fit"
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "dofek_fit_preview_wildcard" {
  zone_id = cloudflare_zone.dofek_fit.id
  type    = "CNAME"
  name    = "*.preview.dofek.fit"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

# --- dofek.live ---

resource "cloudflare_zone" "dofek_live" {
  account = {
    id = var.cloudflare_account_id
  }
  name = "dofek.live"
}

resource "cloudflare_dns_record" "dofek_live_root" {
  zone_id = cloudflare_zone.dofek_live.id
  type    = "A"
  name    = "dofek.live"
  content = hcloud_server.dofek.ipv4_address
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "dofek_live_www" {
  zone_id = cloudflare_zone.dofek_live.id
  type    = "CNAME"
  name    = "www.dofek.live"
  content = "dofek.live"
  proxied = true
  ttl     = 1
}

# --- asherlc.com (dofek subdomains) ---

data "cloudflare_zone" "asherlc_com" {
  filter = {
    name = "asherlc.com"
  }
}

resource "cloudflare_dns_record" "dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "dofek.asherlc.com"
  content = var.oracle_server_host
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "wildcard_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "*.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "ota_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "ota.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "portainer_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "portainer.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "netdata_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "netdata.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "databasus_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "databasus.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "cloudbeaver_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "cloudbeaver.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "pgadmin_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "pgadmin.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "peerdb_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "peerdb.dofek.asherlc.com"
  content = "dofek-hetzner.asherlc.com"
  proxied = false
  ttl     = 1
}

# --- dofek-hetzner alias (Hetzner server, replaces direct IP references) ---

resource "cloudflare_dns_record" "dofek_hetzner_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "dofek-hetzner.asherlc.com"
  content = hcloud_server.dofek.ipv4_address
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_ota_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-ota.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_portainer_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-portainer.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_netdata_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-netdata.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_databasus_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-databasus.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_cloudbeaver_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-cloudbeaver.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_pgadmin_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-pgadmin.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "staging_peerdb_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "A"
  name    = "staging-peerdb.dofek.asherlc.com"
  content = hcloud_server.dofek_staging.ipv4_address
  proxied = false
  ttl     = 1
}
