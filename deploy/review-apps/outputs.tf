output "review_host" {
  value = local.review_host
}

output "review_url" {
  value = "https://${local.review_host}"
}

output "review_server_ip" {
  value = hcloud_server.review.ipv4_address
}
