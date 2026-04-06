variable "server_ip" {
  description = "Server IP address to deploy config to"
  type        = string
}

variable "ssh_public_key" {
  description = "SSH public key to ensure is in authorized_keys"
  type        = string
  default     = ""
}

resource "null_resource" "deploy_config" {
  triggers = {
    compose_hash   = filemd5("${path.module}/../docker-compose.yml")
    caddy_hash     = filemd5("${path.module}/../Caddyfile")
    collector_hash = filemd5("${path.module}/../otel-collector-config.yaml")
    deploy_hash    = filemd5("${path.module}/../deploy.sh")
    config_hash    = filemd5("${path.module}/../../.env")
  }

  connection {
    type  = "ssh"
    host  = var.server_ip
    user  = "root"
    agent = true
  }

  provisioner "file" {
    source      = "${path.module}/../../.env"
    destination = "/opt/dofek/config.env"
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

  provisioner "file" {
    source      = "${path.module}/../deploy.sh"
    destination = "/opt/dofek/deploy.sh"
  }

  provisioner "remote-exec" {
    inline = [
      "if [ -n '${var.ssh_public_key}' ]; then mkdir -p ~/.ssh && grep -qxF '${var.ssh_public_key}' ~/.ssh/authorized_keys 2>/dev/null || echo '${var.ssh_public_key}' >> ~/.ssh/authorized_keys; fi",
      "chmod +x /opt/dofek/deploy.sh",
      "chmod 600 /opt/dofek/config.env",
      "cd /opt/dofek && ./deploy.sh"
    ]
  }
}
