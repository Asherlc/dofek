locals {
  activity_search_project = "dofek"
  activity_search_service = "dofek-opensearch"
  activity_search_index   = "dofek-activity-search-v1"
  activity_search_roles   = { erase = "admin", read = "read", write = "readwrite" }
  activity_search_mappings = {
    dynamic = "strict"
    properties = {
      activityId   = { type = "keyword" }
      activityType = { type = "keyword" }
      startedAt    = { type = "date" }
      state        = { type = "object", enabled = false }
      title        = { type = "search_as_you_type", doc_values = false, max_shingle_size = 3 }
      userId       = { type = "keyword" }
    }
  }
}

# Authentication comes from the existing Terraform workflow's Infisical session.
provider "aiven" {}

import {
  to = aiven_opensearch.activity_search
  id = "${local.activity_search_project}/${local.activity_search_service}"
}

resource "aiven_opensearch" "activity_search" {
  project      = local.activity_search_project
  service_name = local.activity_search_service
  plan         = "developer-4-30"
  cloud_name   = "do-nyc"

  lifecycle {
    prevent_destroy = true
  }
}

# Configure the index provider from the live service so an import plan can read
# the endpoint and its administrative credential before applying changes.
data "aiven_opensearch" "activity_search" {
  project      = local.activity_search_project
  service_name = local.activity_search_service
}

provider "opensearch" {
  url               = "https://${data.aiven_opensearch.activity_search.service_host}:${data.aiven_opensearch.activity_search.service_port}"
  username          = data.aiven_opensearch.activity_search.service_username
  password          = data.aiven_opensearch.activity_search.service_password
  sign_aws_requests = false
}

resource "opensearch_index_template" "activity_search" {
  name = local.activity_search_index
  body = jsonencode({
    index_patterns = [local.activity_search_index]
    template = {
      settings = {
        index = {
          number_of_shards   = "1"
          number_of_replicas = "0"
          merge = {
            policy = { expunge_deletes_allowed = "0" }
          }
        }
      }
      mappings = local.activity_search_mappings
    }
  })
}

resource "opensearch_index" "activity_search" {
  name               = local.activity_search_index
  number_of_shards   = "1"
  number_of_replicas = "0"
  mappings           = jsonencode(local.activity_search_mappings)
  depends_on         = [opensearch_index_template.activity_search]

  lifecycle {
    prevent_destroy = true
  }
}

resource "aiven_opensearch_acl_config" "activity_search" {
  project      = aiven_opensearch.activity_search.project
  service_name = aiven_opensearch.activity_search.service_name
  enabled      = true
  extended_acl = true
}

resource "aiven_opensearch_user" "activity_search" {
  for_each = local.activity_search_roles

  project      = aiven_opensearch.activity_search.project
  service_name = aiven_opensearch.activity_search.service_name
  username     = "activity-search-${each.key}"
  depends_on   = [aiven_opensearch_acl_config.activity_search]
}

resource "aiven_opensearch_acl_rule" "activity_search" {
  for_each = local.activity_search_roles

  project      = aiven_opensearch.activity_search.project
  service_name = aiven_opensearch.activity_search.service_name
  username     = aiven_opensearch_user.activity_search[each.key].username
  index        = local.activity_search_index
  permission   = each.value
}

resource "infisical_secret" "activity_search_uri" {
  for_each = local.activity_search_roles

  name         = "ACTIVITY_SEARCH_${upper(each.key)}_URL"
  value        = "https://${aiven_opensearch_user.activity_search[each.key].username}:${urlencode(aiven_opensearch_user.activity_search[each.key].password)}@${data.aiven_opensearch.activity_search.service_host}:${data.aiven_opensearch.activity_search.service_port}"
  env_slug     = "prod"
  workspace_id = local.infisical_project_id
  folder_path  = "/"
  depends_on   = [aiven_opensearch_acl_rule.activity_search, opensearch_index.activity_search]
}
