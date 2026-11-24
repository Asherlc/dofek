terraform {
  required_version = ">= 1.16.6"

  required_providers {
    infisical = {
      source  = "infisical/infisical"
      version = "0.20.18"
    }
    oci = {
      source  = "oracle/oci"
      version = "6.37.0"
    }
  }
}

provider "oci" {
  auth                = "SecurityToken"
  config_file_profile = var.bootstrap_profile
  region              = var.region
}

variable "bootstrap_profile" {
  description = "OCI CLI config profile used for Security Token authentication."
  type        = string
  default     = "DOFEK_BOOTSTRAP"
}

variable "region" {
  description = "OCI region in which the deploy IAM resources are created."
  type        = string
  default     = "us-sanjose-1"
}

variable "tenancy_ocid" {
  description = "OCID of the tenancy in which the deploy IAM resources are created."
  type        = string
}

variable "public_key_path" {
  description = "Path to the public key file uploaded as the deploy user API key."
  type        = string
}

variable "deploy_email" {
  description = "Unique primary email required by the OCI identity domain."
  type        = string
}

resource "oci_identity_user" "deploy" {
  name           = "dofek-terraform-deploy"
  description    = "Deploy user for Terraform-managed OCI infrastructure."
  compartment_id = var.tenancy_ocid
  email          = var.deploy_email
}

resource "oci_identity_group" "deploy" {
  name           = "dofek-terraform-deploy"
  description    = "Deploy group for Terraform-managed OCI infrastructure."
  compartment_id = var.tenancy_ocid
}

resource "oci_identity_user_group_membership" "deploy" {
  user_id  = oci_identity_user.deploy.id
  group_id = oci_identity_group.deploy.id
}

resource "oci_identity_api_key" "deploy" {
  user_id   = oci_identity_user.deploy.id
  key_value = file(var.public_key_path)
}

resource "oci_identity_policy" "deploy" {
  name           = "dofek-terraform-deploy"
  description    = "Grants the deploy group read access to core resources and scoped security-list update access."
  compartment_id = var.tenancy_ocid

  statements = [
    "Allow group ${oci_identity_group.deploy.name} to read instance-family in tenancy",
    "Allow group ${oci_identity_group.deploy.name} to read volumes in tenancy",
    "Allow group ${oci_identity_group.deploy.name} to read volume-attachments in tenancy",
    "Allow group ${oci_identity_group.deploy.name} to read virtual-network-family in tenancy",
    "Allow group ${oci_identity_group.deploy.name} to manage security-lists in tenancy where all {request.permission = 'SECURITY_LIST_UPDATE', target.compartment.id = '${var.tenancy_ocid}'}",
  ]
}

output "deploy_user_ocid" {
  description = "OCID of the deploy user."
  value       = oci_identity_user.deploy.id
}

output "public_key_fingerprint" {
  description = "Fingerprint of the uploaded deploy user API public key."
  value       = oci_identity_api_key.deploy.fingerprint
}
