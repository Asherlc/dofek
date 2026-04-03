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
}

variable "slack_client_secret" {
  description = "Slack OAuth app client secret"
  type        = string
  sensitive   = true
}

resource "null_resource" "deploy_config" {
  triggers = {
    compose_hash        = filemd5("${path.module}/../docker-compose.yml")
    caddy_hash          = filemd5("${path.module}/../Caddyfile")
    collector_hash      = filemd5("${path.module}/../otel-collector-config.yaml")
    r2_bucket           = var.r2_bucket
    slack_client_id     = var.slack_client_id
    slack_client_secret = var.slack_client_secret
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
      "if grep -q '^SLACK_CLIENT_ID=' /opt/dofek/.env; then sed -i 's/^SLACK_CLIENT_ID=.*/SLACK_CLIENT_ID=${var.slack_client_id}/' /opt/dofek/.env; else printf '\\nSLACK_CLIENT_ID=${var.slack_client_id}\\n' >> /opt/dofek/.env; fi",
      "if grep -q '^SLACK_CLIENT_SECRET=' /opt/dofek/.env; then sed -i 's/^SLACK_CLIENT_SECRET=.*/SLACK_CLIENT_SECRET=${var.slack_client_secret}/' /opt/dofek/.env; else printf '\\nSLACK_CLIENT_SECRET=${var.slack_client_secret}\\n' >> /opt/dofek/.env; fi",
      "cd /opt/dofek && docker compose up -d --scale web=2 --scale client=2"
    ]
  }
}
