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
    compose_hash        = filemd5("${path.module}/../docker-compose.yml")
    caddy_hash          = filemd5("${path.module}/../Caddyfile")
    collector_hash      = filemd5("${path.module}/../otel-collector-config.yaml")
    r2_bucket           = var.r2_bucket
    slack_client_id     = var.slack_client_id
    slack_client_secret = var.slack_client_secret
    axiom_api_token     = var.axiom_api_token
    slack_bot_token     = var.slack_bot_token
    ghcr_token          = var.ghcr_token
    ghcr_username       = var.ghcr_username
  }

  connection {
    type  = "ssh"
    host  = var.server_ip
    user  = "root"
    agent = true
  }

  provisioner "file" {
    source      = "${path.module}/../docker-compose.yml"
    destination = "/opt/dofek/docker-compose.yml"
  }

  provisioner "file" {
    source      = "${path.module}/../Caddyfile"
    destination = "/opt/dofek/Caddyfile"
  }

  provisioner "file" {
    source      = "${path.module}/../otel-collector-config.yaml"
    destination = "/opt/dofek/otel-collector-config.yaml"
  }

  provisioner "remote-exec" {
    inline = [
      "if grep -q '^R2_BUCKET=' /opt/dofek/.env; then sed -i 's/^R2_BUCKET=.*/R2_BUCKET=${var.r2_bucket}/' /opt/dofek/.env; else printf '\\nR2_BUCKET=${var.r2_bucket}\\n' >> /opt/dofek/.env; fi",
      "[ -z '${var.slack_client_id}' ] || { if grep -q '^SLACK_CLIENT_ID=' /opt/dofek/.env; then sed -i 's/^SLACK_CLIENT_ID=.*/SLACK_CLIENT_ID=${var.slack_client_id}/' /opt/dofek/.env; else printf '\\nSLACK_CLIENT_ID=${var.slack_client_id}\\n' >> /opt/dofek/.env; fi; }",
      "[ -z '${var.slack_client_secret}' ] || { if grep -q '^SLACK_CLIENT_SECRET=' /opt/dofek/.env; then sed -i 's/^SLACK_CLIENT_SECRET=.*/SLACK_CLIENT_SECRET=${var.slack_client_secret}/' /opt/dofek/.env; else printf '\\nSLACK_CLIENT_SECRET=${var.slack_client_secret}\\n' >> /opt/dofek/.env; fi; }",
      "if grep -q '^AXIOM_API_TOKEN=' /opt/dofek/.env; then sed -i 's/^AXIOM_API_TOKEN=.*/AXIOM_API_TOKEN=${var.axiom_api_token}/' /opt/dofek/.env; else printf '\\nAXIOM_API_TOKEN=${var.axiom_api_token}\\n' >> /opt/dofek/.env; fi",
      "if grep -q '^SLACK_BOT_TOKEN=' /opt/dofek/.env; then sed -i 's/^SLACK_BOT_TOKEN=.*/SLACK_BOT_TOKEN=${var.slack_bot_token}/' /opt/dofek/.env; else printf '\\nSLACK_BOT_TOKEN=${var.slack_bot_token}\\n' >> /opt/dofek/.env; fi",
      "echo '{\"auths\":{\"ghcr.io\":{\"auth\":\"'$(echo -n '${var.ghcr_username}:${var.ghcr_token}' | base64)'\"}}}'  > /root/.docker/config.json",
      "cd /opt/dofek && docker compose up -d --scale web=2 --scale client=2"
    ]
  }
}
