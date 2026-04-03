variable "server_ip" {
  description = "Server IP address to deploy config to"
  type        = string
}

variable "r2_bucket" {
  description = "R2 bucket name used by production services"
  type        = string
  default     = "dofek-training-data"
}

variable "slack_client_id" {
  description = "Slack OAuth app client ID"
  type        = string
  sensitive   = true
  default     = ""
}

variable "slack_client_secret" {
  description = "Slack OAuth app client secret"
  type        = string
  sensitive   = true
  default     = ""
}

variable "axiom_api_token" {
  description = "Axiom API token (xaat-...) for OTEL collector log/metric/trace export"
  type        = string
  sensitive   = true
}

variable "slack_bot_token" {
  description = "Slack bot token (xoxb-...) for Watchtower notifications and app bot"
  type        = string
  sensitive   = true
}

variable "ghcr_token" {
  description = "GitHub PAT (ghp_...) with read:packages scope for pulling images from GHCR"
  type        = string
  sensitive   = true
}

variable "ghcr_username" {
  description = "GitHub username for GHCR authentication"
  type        = string
  default     = "asherlc"
}

resource "null_resource" "deploy_config" {
  triggers = {
    compose_hash                 = filemd5("${path.module}/../docker-compose.yml")
    hotfix_compose_hash          = filemd5("${path.module}/../docker-compose.hotfix.yml")
    caddy_hash                   = filemd5("${path.module}/../Caddyfile")
    collector_hash               = filemd5("${path.module}/../otel-collector-config.yaml")
    root_index_patch_hash        = filemd5("${path.module}/../../src/index.ts")
    provider_index_patch_hash    = filemd5("${path.module}/../../src/providers/index.ts")
    process_sync_patch_hash      = filemd5("${path.module}/../../src/jobs/process-sync-job.ts")
    process_scheduled_patch_hash = filemd5("${path.module}/../../src/jobs/process-scheduled-sync-job.ts")
    training_export_patch_hash   = filemd5("${path.module}/../../src/jobs/process-training-export-job.ts")
    r2_bucket                    = var.r2_bucket
    slack_client_id              = var.slack_client_id
    slack_client_secret          = var.slack_client_secret
    axiom_api_token              = var.axiom_api_token
    slack_bot_token              = var.slack_bot_token
    ghcr_token                   = var.ghcr_token
    ghcr_username                = var.ghcr_username
  }

  provisioner "local-exec" {
    interpreter = ["/bin/bash", "-lc"]
    command     = <<-EOT
      set -euo pipefail
      ssh root@${var.server_ip} "mkdir -p /opt/dofek/patches"
      scp ${path.module}/../docker-compose.yml root@${var.server_ip}:/opt/dofek/docker-compose.yml
      scp ${path.module}/../docker-compose.hotfix.yml root@${var.server_ip}:/opt/dofek/docker-compose.hotfix.yml
      scp ${path.module}/../Caddyfile root@${var.server_ip}:/opt/dofek/Caddyfile
      scp ${path.module}/../otel-collector-config.yaml root@${var.server_ip}:/opt/dofek/otel-collector-config.yaml
      scp ${path.module}/../../src/index.ts root@${var.server_ip}:/opt/dofek/patches/index.ts
      scp ${path.module}/../../src/providers/index.ts root@${var.server_ip}:/opt/dofek/patches/providers-index.ts
      scp ${path.module}/../../src/jobs/process-sync-job.ts root@${var.server_ip}:/opt/dofek/patches/process-sync-job.ts
      scp ${path.module}/../../src/jobs/process-scheduled-sync-job.ts root@${var.server_ip}:/opt/dofek/patches/process-scheduled-sync-job.ts
      scp ${path.module}/../../src/jobs/process-training-export-job.ts root@${var.server_ip}:/opt/dofek/patches/process-training-export-job.ts
      ssh root@${var.server_ip} "if grep -q '^R2_BUCKET=' /opt/dofek/.env; then sed -i 's/^R2_BUCKET=.*/R2_BUCKET=${var.r2_bucket}/' /opt/dofek/.env; else printf '\nR2_BUCKET=${var.r2_bucket}\n' >> /opt/dofek/.env; fi"
      [ -n "${var.slack_client_id}" ] && ssh root@${var.server_ip} "if grep -q '^SLACK_CLIENT_ID=' /opt/dofek/.env; then sed -i 's/^SLACK_CLIENT_ID=.*/SLACK_CLIENT_ID=${var.slack_client_id}/' /opt/dofek/.env; else printf '\nSLACK_CLIENT_ID=${var.slack_client_id}\n' >> /opt/dofek/.env; fi" || true
      [ -n "${var.slack_client_secret}" ] && ssh root@${var.server_ip} "if grep -q '^SLACK_CLIENT_SECRET=' /opt/dofek/.env; then sed -i 's/^SLACK_CLIENT_SECRET=.*/SLACK_CLIENT_SECRET=${var.slack_client_secret}/' /opt/dofek/.env; else printf '\nSLACK_CLIENT_SECRET=${var.slack_client_secret}\n' >> /opt/dofek/.env; fi" || true
      ssh root@${var.server_ip} "if grep -q '^AXIOM_API_TOKEN=' /opt/dofek/.env; then sed -i 's/^AXIOM_API_TOKEN=.*/AXIOM_API_TOKEN=${var.axiom_api_token}/' /opt/dofek/.env; else printf '\nAXIOM_API_TOKEN=${var.axiom_api_token}\n' >> /opt/dofek/.env; fi"
      ssh root@${var.server_ip} "if grep -q '^SLACK_BOT_TOKEN=' /opt/dofek/.env; then sed -i 's/^SLACK_BOT_TOKEN=.*/SLACK_BOT_TOKEN=${var.slack_bot_token}/' /opt/dofek/.env; else printf '\nSLACK_BOT_TOKEN=${var.slack_bot_token}\n' >> /opt/dofek/.env; fi"
      ssh root@${var.server_ip} "echo '{\"auths\":{\"ghcr.io\":{\"auth\":\"'$(echo -n '${var.ghcr_username}:${var.ghcr_token}' | base64)'\"}}}'  > /root/.docker/config.json"
      ssh root@${var.server_ip} "cd /opt/dofek && docker compose -f docker-compose.yml -f docker-compose.hotfix.yml up -d --scale web=2 --scale client=2"
    EOT
  }
}
