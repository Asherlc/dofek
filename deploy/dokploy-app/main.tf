# Deploys a single Dokploy application (web or worker) to a new image tag.
# CI passes the SHA-tagged image after pushing to GHCR.
#
# Usage: terraform apply -var="image_tag=sha-abc123" -var="app_id=..."

variable "dokploy_host" {
  description = "Dokploy API base URL"
  type        = string
}

variable "dokploy_api_key" {
  description = "Dokploy API key"
  type        = string
  sensitive   = true
}

variable "app_id" {
  description = "Dokploy application ID to deploy"
  type        = string
}

variable "image_tag" {
  description = "SHA-tagged image to deploy (e.g. sha-abc123)"
  type        = string
}

variable "registry" {
  description = "Container registry"
  type        = string
  default     = "ghcr.io"
}

variable "image_name" {
  description = "Image name without tag"
  type        = string
  default     = "asherlc/dofek"
}

locals {
  full_image = "${var.registry}/${var.image_name}:${var.image_tag}"
}

resource "terraform_data" "deploy" {
  triggers_replace = [var.app_id, local.full_image]

  provisioner "local-exec" {
    interpreter = ["bash", "-c"]
    command     = <<-EOT
      set -euo pipefail
      echo "Updating app ${var.app_id} image to ${local.full_image}..."
      curl -fsSL -X POST "${var.dokploy_host}/api/trpc/application.update" \
        -H "x-api-key: $DOKPLOY_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"json\":{\"applicationId\":\"${var.app_id}\",\"sourceType\":\"docker\",\"dockerImage\":\"${local.full_image}\"}}"

      echo "Deploying app ${var.app_id}..."
      curl -fsSL -X POST "${var.dokploy_host}/api/trpc/application.deploy" \
        -H "x-api-key: $DOKPLOY_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{\"json\":{\"applicationId\":\"${var.app_id}\"}}"
    EOT

    environment = {
      DOKPLOY_API_KEY = var.dokploy_api_key
    }
  }
}
