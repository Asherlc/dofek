# --- OCI authentication (from `oci setup keys` + the Console) ---

variable "tenancy_ocid" {
  description = "OCID of your tenancy (Console -> Profile -> Tenancy)"
  type        = string
}

variable "user_ocid" {
  description = "OCID of the user whose API key signs requests (Console -> Profile -> My profile)"
  type        = string
}

variable "fingerprint" {
  description = "Fingerprint of the API signing key registered on the user"
  type        = string
}

variable "private_key_path" {
  description = "Local path to the API signing private key (PEM)"
  type        = string
}

variable "region" {
  description = "OCI region identifier, e.g. eu-frankfurt-1 (this is your locked home region)"
  type        = string
}

variable "compartment_ocid" {
  description = "OCID of the compartment to provision into (root tenancy OCID is fine for a personal setup)"
  type        = string
}

# --- Access ---

variable "ssh_public_key" {
  description = "SSH public key contents for instance access (ubuntu user)"
  type        = string
}

variable "ssh_source_cidr" {
  description = "CIDR allowed to reach SSH (port 22). Lock this down to your IP if possible."
  type        = string
  default     = "0.0.0.0/0"
}

# --- Instance sizing (Always Free A1 ceiling is 4 OCPU / 24 GB total) ---

variable "instance_display_name" {
  description = "Display name for the compute instance"
  type        = string
  default     = "dofek"
}

variable "availability_domain_index" {
  description = "Index into the region's availability domains. Bump this (0,1,2) to retry a different AD on 'Out of host capacity'."
  type        = number
  default     = 0
}

variable "instance_ocpus" {
  description = "Ampere A1 OCPUs (Always Free max 4)"
  type        = number
  default     = 4
}

variable "instance_memory_gb" {
  description = "Memory in GB (A1 is fixed at 6 GB per OCPU; Always Free max 24)"
  type        = number
  default     = 24
}

# --- Storage (Always Free block pool is 200 GB total, boot + data combined) ---

variable "boot_volume_size_gb" {
  description = "Boot volume size in GB"
  type        = number
  default     = 50
}

variable "data_volume_size_gb" {
  description = "Dedicated data volume size in GB, mounted at /mnt/dofek-data (set 0 to keep everything on the boot disk)"
  type        = number
  default     = 150
}
