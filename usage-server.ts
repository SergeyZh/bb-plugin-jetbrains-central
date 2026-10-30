import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { UsageCache, usageFailure } from "./usage.js";
import { sourceMeasurement, threadUsageContract, usageHostContract, usageSourceContract } from "./usage-contract.js";

export function registerUsage(bb: BbPluginApi, command: string, providerIds: ReadonlySet<string>) {
  const lifecycle = new AbortController();
  bb.onDispose(() => lifecycle.abort());
  const host = bb.hosts.experimental_client({ contract: usageHostContract });
  const cache = new UsageCache(async hostId => {
    const machine = await bb.sdk.hosts.get({ hostId });
    if (machine.status !== "connected") return usageFailure("error", "Central's machine is disconnected.");
    return host.call("centralUsage", { command }, { hostId, signal: lifecycle.signal, timeoutMs: 15_000 });
  });
  const resourceId = (hostId: string) => JSON.stringify([hostId, "central"]);
  const resourceKey = z.tuple([z.string().min(1), z.literal("central")]);
  bb.rpc.register(usageSourceContract, {
    async "provider-usage.v1.listResources"() {
      const machines = await bb.sdk.hosts.list();
      return { resources: providerIds.size === 0 ? [] : machines.filter(machine => machine.type !== "ephemeral").map(machine => ({
        id: resourceId(machine.id), providerId: "central", label: "JetBrains Central", accountKey: null,
        scope: { kind: "host" as const, hostId: machine.id, hostName: machine.name },
      })) };
    },
    async "provider-usage.v1.getResource"({ resourceId: id, refresh }) {
      const [hostId] = resourceKey.parse(JSON.parse(id));
      const machine = await bb.sdk.hosts.get({ hostId });
      if (machine.type === "ephemeral" || providerIds.size === 0) throw new Error("Central usage resource no longer exists.");
      return sourceMeasurement(await cache.get(hostId, refresh));
    },
  }, { experimental_discoverable: true, experimental_description: "JetBrains Central credits, shared by all Central agent profiles on each machine." });
  bb.rpc.register(threadUsageContract, {
    async threadUsage({ threadId, refresh }) {
      const thread = await bb.sdk.threads.get({ threadId });
      if (!providerIds.has(thread.providerId)) return null;
      if (!thread.environmentId) return usageFailure("error", "This Central thread has no machine yet.");
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      if (!environment.hostId) return usageFailure("error", "This Central thread has no machine yet.");
      const value = await cache.get(environment.hostId, refresh);
      if (refresh) bb.rpc.experimental_invalidateAll();
      return value;
    },
  });
  const dirty = async ({ thread }: { thread: { providerId: string; environmentId: string | null } }) => {
    if (!providerIds.has(thread.providerId) || !thread.environmentId) return;
    const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
    if (environment.hostId) cache.markDirty(environment.hostId);
    bb.rpc.experimental_invalidateAll();
  };
  bb.events.on("thread.idle", dirty);
  bb.events.on("thread.failed", dirty);
  bb.events.on("experimental_host.deleted", ({ host: machine }) => cache.invalidate(machine.id));
}
