# Oracle Cloud Infrastructure (OCI) Always Free Terraform root for Dofek.
#
# Provisions a single-node Docker Swarm host on the Always Free Ampere A1
# shape (4 OCPU / 24 GB). Production deploys happen from CI via a remote
# Docker context (SSH); this root only provisions infrastructure, never secrets
# or app deploys.
#
# Uses a local backend (no Terraform Cloud workspace) so it stays isolated
# from the primary deploy/ root.

terraform {
  required_version = ">= 1.6"
  required_providers {
    oci = {
      source  = "oracle/oci"
      version = "~> 6.0"
    }
  }
}

provider "oci" {
  tenancy_ocid = var.tenancy_ocid
  user_ocid    = var.user_ocid
  fingerprint  = var.fingerprint
  # pathexpand so a leading ~ in the key path resolves (Terraform does not
  # expand ~ on its own).
  private_key_path = pathexpand(var.private_key_path)
  region           = var.region
}
