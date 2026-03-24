terraform {
  cloud {
    organization = "dofek"

    workspaces {
      name = "deploy-config"
    }
  }
}

variable "server_ip" {
  description = "Server IP address to deploy config to"
  type        = string
}

resource "null_resource" "deploy_config" {
  triggers = {
    compose_hash   = filemd5("${path.module}/../docker-compose.yml")
    caddy_hash     = filemd5("${path.module}/../Caddyfile")
    collector_hash = filemd5("${path.module}/../otel-collector-config.yaml")
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
      "cd /opt/dofek && docker compose up -d"
    ]
  }
}
