# An HCL fixture, as tofu fmt formats it.
terraform {
  required_version = ">= 1.6"
  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.45"
    }
  }
}

variable "names" {
  type = list(string)
  default = [
    "a",
    "b",
  ]
}

locals {
  /* a block
     comment */
  tags = merge(var.tags, {
    name = "x"
  })
  servers = {
    for k, v in var.servers : k => {
      type = v.type
    }
  }
  list = [for s in var.names : upper(s)]
  cond = var.enabled ? {
    a = 1
  } : {}
  heredoc = <<-EOT
    kept
      as is ${var.x}
EOT
  call = format(
    "%s-%s",
    var.a,
    var.b,
  )
  ünïcode = "ß"
}

resource "hcloud_server" "web" {
  count = 2
  name  = "web-${count.index}"

  dynamic "network" {
    for_each = var.networks
    content {
      id = network.value
    }
  }

  lifecycle {
    ignore_changes = [
      user_data,
    ]
  }
}
