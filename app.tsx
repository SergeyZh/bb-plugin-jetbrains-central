import { definePluginApp, experimental_useThreadContextKind, useSettings } from "@get-bb/plugin-sdk/app";
import { CentralIcon, CentralProviderIcon } from "./provider-icon.js";
import type { ProviderMark } from "./artwork.js";
import { CentralUsageSummary, CentralUsageDetails, CentralUsageRow, useCentralThread } from "./usage-ui.js";

export default definePluginApp(app => {
  app.slots.experimental_providerIcon({ providerKind: "agent", providerId: "central", icon: CentralIcon });
  app.slots.experimental_threadContextSegment({
    id: "central-credits", title: "Central credits", group: "3_central",
    summary: CentralUsageSummary, details: CentralUsageDetails,
    useVisible: ({ threadId }) => {
      const central = useCentralThread(threadId);
      const kind = experimental_useThreadContextKind();
      const { values } = useSettings();
      return kind === "banner" && central && values?.showCreditsInBanner !== false;
    },
  });
  app.slots.experimental_threadContextCardRow({
    id: "central-credits", group: "3_central", component: CentralUsageRow,
  });
  for (const provider of ["codex", "claude-code", "pi"] as const satisfies readonly ProviderMark[]) {
    app.slots.experimental_providerIcon({
      providerKind: "agent",
      providerId: `central-${provider}`,
      icon: ({ className }) => <CentralProviderIcon provider={provider} className={className} />,
    });
  }
});
