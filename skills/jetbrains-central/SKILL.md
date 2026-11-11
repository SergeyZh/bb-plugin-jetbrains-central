---
name: jetbrains-central
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
Display remaining credits rounded to whole numbers. Provider usage's percentage
bar still represents consumption; preserve its `usedPercent` semantics.

For diagnostics, use `central limit --json` on the thread's execution machine.
If unauthenticated, the user must sign in with `central login` on that machine.
Never read, print, or copy credentials. Do not forward raw CLI stderr.

The plugin exposes discoverable RPC methods
`provider-usage.v1.listResources` (cheap inventory) and
`provider-usage.v1.getResource` (`resourceId` from inventory, `refresh` boolean).
Use `bb plugin rpc call jetbrains-central <method> --input-file <json-path> --json`.
`--input-file` requires a real file path. Reads share a 60-second cache; manual
refresh bypasses it. Different machines' accounts are not merged by email.

Settings in Installed plugins → JetBrains Central:
`centralCommand` (executable path, default `central`),
`showCreditsInBanner` (default `true`; hides only banner credits, applies immediately),
`builtinPluginsDirectory` (optional path on the execution machine),
`profiles` (JSON work profiles). Reload `jetbrains-central` after changing paths or profiles.
Keep existing profile IDs stable because threads persist them.
Central does not set `ANTHROPIC_DEFAULT_FABLE_MODEL`, so Claude Code hides Fable behind
Central's gateway. To show Fable 5.2, add `["--settings", "{\"env\":{\"ANTHROPIC_DEFAULT_FABLE_MODEL\":\"claude-fable-5-2\"}}"]`
to the `claude-code` profile's `args`, then reload `jetbrains-central` when no Central turn is running.
