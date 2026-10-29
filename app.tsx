import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { CentralProviderIcon } from "./provider-icon.js";
import type { ProviderMark } from "./artwork.js";

export default definePluginApp(app => {
  for (const provider of ["codex", "claude-code", "pi"] as const satisfies readonly ProviderMark[]) {
    app.slots.experimental_providerIcon({
      providerKind: "agent",
      providerId: `central-${provider}`,
      icon: ({ className }) => <CentralProviderIcon provider={provider} className={className} />,
    });
  }
});
