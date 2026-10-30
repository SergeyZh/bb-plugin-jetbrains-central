---
name: central
description: Use JetBrains Central work providers and inspect their shared credit allowance in BB.
---

# JetBrains Central

Work providers are `central-codex`, `central-claude-code`, `central-pi`, or
custom `central-<profile-id>` entries. Select them explicitly; preserve personal
provider settings. Central manages credentials and the active AI access source.

Credit allowance appears in bb's Provider usage sidebar disclosure under
`central` for each machine, and in the context of Central threads. Main and
top-up balances are separate. Values are credits, including CLI fields named
`usedDollars` and `maxDollars`; never label them USD or infer thread costs.

For diagnostics, use `central limit --json` on the thread's execution machine.
If unauthenticated, the user must sign in with `central login` on that machine.
Never read, print, or copy credentials. Do not forward raw CLI stderr.

The plugin exposes discoverable RPC methods
`provider-usage.v1.listResources` (cheap inventory) and
`provider-usage.v1.getResource` (`resourceId` from inventory, `refresh` boolean).
Use `bb plugin rpc call central <method> --input-file <json-path> --json`.
`--input-file` requires a real file path. Reads share a 60-second cache; manual
refresh bypasses it. Different machines' accounts are not merged by email.

Settings in Installed plugins → JetBrains Central:
`centralCommand` (executable path, default `central`),
`builtinPluginsDirectory` (optional path on the execution machine),
`profiles` (JSON work profiles). Reload `central` after changing settings.
Keep existing profile IDs stable because threads persist them.
