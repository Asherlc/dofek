data "oci_identity_availability_domains" "ads" {
  compartment_id = var.tenancy_ocid
}

resource "oci_core_vcn" "dofek" {
  compartment_id = var.compartment_ocid
  cidr_blocks    = ["10.0.0.0/16"]
  display_name   = "dofek-vcn"
  dns_label      = "dofek"
}

resource "oci_core_internet_gateway" "dofek" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dofek.id
  display_name   = "dofek-igw"
  enabled        = true
}

resource "oci_core_route_table" "dofek" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dofek.id
  display_name   = "dofek-rt"

  route_rules {
    destination       = "0.0.0.0/0"
    network_entity_id = oci_core_internet_gateway.dofek.id
  }
}

resource "oci_core_security_list" "dofek" {
  compartment_id = var.compartment_ocid
  vcn_id         = oci_core_vcn.dofek.id
  display_name   = "dofek-sl"

  egress_security_rules {
    destination = "0.0.0.0/0"
    protocol    = "all"
  }

  # SSH
  ingress_security_rules {
    protocol = "6" # TCP
    source   = var.ssh_source_cidr
    tcp_options {
      min = 22
      max = 22
    }
  }

  # HTTP
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 80
      max = 80
    }
  }

  # HTTPS
  ingress_security_rules {
    protocol = "6"
    source   = "0.0.0.0/0"
    tcp_options {
      min = 443
      max = 443
    }
  }
}

resource "oci_core_subnet" "dofek" {
  compartment_id    = var.compartment_ocid
  vcn_id            = oci_core_vcn.dofek.id
  cidr_block        = "10.0.1.0/24"
  display_name      = "dofek-subnet"
  route_table_id    = oci_core_route_table.dofek.id
  security_list_ids = [oci_core_security_list.dofek.id]
  dns_label         = "dofek"
}
