output "server_ip" {
  value = hcloud_server.dofek.ipv4_address
}

output "server_ipv6" {
  value = hcloud_server.dofek.ipv6_address
}

output "staging_server_ip" {
  value = hcloud_server.dofek_staging.ipv4_address
}

output "staging_server_ipv6" {
  value = hcloud_server.dofek_staging.ipv6_address
}

output "dofek_fit_nameservers" {
  description = "Set these as custom nameservers on Namecheap for dofek.fit"
  value       = cloudflare_zone.dofek_fit.name_servers
}

output "dofek_live_nameservers" {
  description = "Set these as custom nameservers on Namecheap for dofek.live"
  value       = cloudflare_zone.dofek_live.name_servers
}

output "r2_endpoint" {
  description = "R2 S3-compatible endpoint URL"
  value       = "https://${var.cloudflare_account_id}.r2.cloudflarestorage.com"
}
