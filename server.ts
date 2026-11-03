import type { BbPluginApi, PluginProviderDeclaration } from "@get-bb/plugin-sdk";
import { defaults, parseProfiles } from "./profiles.js";
import { providerMarks } from "./artwork.js";
import { registerUsage } from "./usage-server.js";

export default async function central(bb: BbPluginApi) {
  const settings = bb.settings.define({
    showCreditsInBanner: { type: "boolean", label: "Show credits in banner", default: true },
    centralCommand: { type: "string", label: "Central executable", default: "central" },
    builtinPluginsDirectory: { type: "string", label: "BB built-in plugins directory (optional)", default: "" },
    profiles: { type: "string", label: "Work provider profiles (JSON)", default: JSON.stringify(defaults) },
  });
  const values = await settings.get();
  const profiles = parseProfiles(JSON.parse(values.profiles));
  registerUsage(bb, values.centralCommand, new Set(profiles.map(profile => `central-${profile.id}`)));
  for (const profile of profiles) {
    const codex = profile.bridge === "codex";
    const claude = profile.bridge === "claude-code";
    const native = profile.bridge !== "acp";
    const declaration: PluginProviderDeclaration = {
      id: `central-${profile.id}`, displayName: profile.displayName, family: "central", icon: native ? `./icons/jetbrains-${profile.bridge}.svg` : "./icons/jetbrains.svg",
      strings: {
        signInHint: "Run central login on this machine.", expiredHint: "Check central run for this agent on this machine.", installUrl: "https://www.jetbrains.com/help/central-cli/quickstart.html",
        ...(native ? {iconTint: {light: providerMarks[profile.bridge as keyof typeof providerMarks].color, dark: providerMarks[profile.bridge as keyof typeof providerMarks].color}} : {}),
      },
      maintenance: { health: false, usage: false, installation: false },
      capabilities: {
        supportsServiceTier: codex || claude, supportsNativeUserQuestion: claude,
        fork: native ? "checkpoint" : "none", supportsManualCompaction: native,
        supportsThreadArchive: codex, supportsThreadRename: codex,
        permissionModes: profile.bridge === "pi" ? ["full"] : ["accept-edits", "auto", "full"],
        reasoningLevels: ["none", "low", "medium", "high", "xhigh", "max"],
      },
      composerActions: codex || claude ? ["plan"] : [],
      models: { scope: "host" },
      ...(codex || claude ? {serviceTiers: [{id: "default", label: "Default"}, {id: "fast", label: "Fast"}]} : {}),
      experimental_bridgeOptions: {
        centralProfile: profile, centralCommand: values.centralCommand,
        builtinPluginsDirectory: values.builtinPluginsDirectory,
      },
      deriveProviderOptions: () => ({ providerSubagentsEnabled: false, memoryEnabled: false }),
    };
    bb.providers.register(declaration);
  }
  bb.log.info("Central work providers registered. Personal providers are unchanged.");
}
