locals {
  dofek_primary_host = var.oracle_server_host
}

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
  content = local.dofek_primary_host
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
  content = local.dofek_primary_host
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
  content = local.dofek_primary_host
  proxied = true
  ttl     = 1
}

resource "cloudflare_dns_record" "wildcard_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "*.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "ota_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "ota.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "portainer_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "portainer.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "netdata_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "netdata.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "databasus_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "databasus.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "cloudbeaver_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "cloudbeaver.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "pgadmin_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "pgadmin.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}

resource "cloudflare_dns_record" "peerdb_dofek_asherlc" {
  zone_id = data.cloudflare_zone.asherlc_com.zone_id
  type    = "CNAME"
  name    = "peerdb.dofek.asherlc.com"
  content = "dofek.asherlc.com"
  proxied = false
  ttl     = 1
}
