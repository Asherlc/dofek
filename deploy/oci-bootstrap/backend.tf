terraform {
  backend "oci" {
    bucket    = "dofek-terraform-state"
    namespace = "axjpzo4z5fbe"
    region    = "us-sanjose-1"
    key       = "bootstrap/terraform.tfstate"
  }
}
