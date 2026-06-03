output "server_ip" {
  description = "Oracle Cloud production server IPv4 address for Docker SSH deploys"
  value       = var.oracle_server_host
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
