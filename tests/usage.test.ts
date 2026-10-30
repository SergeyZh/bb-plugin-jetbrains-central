import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeHostResponse, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../host.js";
import plugin from "../server.js";
import { collectUsage, parseAllowance, UsageCache, usageFailure } from "../usage.js";
import { sourceMeasurement, sourceMeasurementSchema } from "../usage-contract.js";

const allowance = {
  email: "worker@example.test", licenseName: "JetBrains Team", managed: false,
  usedDollars: "7.02", maxDollars: "200.00",
  tariffQuota: { current: "7.02", maximum: "200.00", available: "192.98" },
  topUpQuota: { current: "0.00", maximum: "0.00", available: "0.00" },
  refillLast: 1790812800000, refillNext: 1793491199999,
};

test("real Central allowance becomes credits without USD cost or an inferred account identity", () => {
  const value = parseAllowance(allowance, 1234);
  assert.equal(value.observedAt, 1234);
  assert.deepEqual(value.balances, [{ id: "tariff", label: "Central", used: 7.02, limit: 200,
    available: 192.98, resetsAt: new Date(allowance.refillNext).toISOString() }]);
  const measurement = sourceMeasurement(value);
  assert.equal(measurement.accountKey, null);
  assert.equal(measurement.usage.status, "ok");
  if (measurement.usage.status !== "ok") throw new Error("Expected quota");
  assert.equal(measurement.usage.windows[0].label, "193/200 cr.");
  assert.equal(measurement.usage.windows[0].cost, null);
  assert.ok(Math.abs(measurement.usage.windows[0].usedPercent - 3.51) < 1e-10);
});

test("top-up is a separate credit balance without an invented reset; legacy and zero limits are valid", () => {
  const value = parseAllowance({ ...allowance, topUpQuota: { current: "2.00", maximum: "50.00", available: "48.00" } });
  assert.equal(value.balances.length, 2);
  assert.equal(value.balances[1].resetsAt, null);
  const legacy = parseAllowance({ usedDollars: "12.50", maxDollars: "10.00" });
  assert.equal(legacy.balances[0].available, 0);
  const measurement = sourceMeasurement(legacy);
  assert.equal(measurement.usage.status === "ok" && measurement.usage.windows[0].usedPercent, 125);
  assert.ok(sourceMeasurementSchema.safeParse(sourceMeasurement(parseAllowance({ usedDollars: 0, maxDollars: 0 }))).success);
  for (const bad of [{}, { usedDollars: "NaN", maxDollars: "200" }, { usedDollars: "Infinity", maxDollars: "200" },
    { tariffQuota: { current: "7.02", maximum: "200" } }]) assert.throws(() => parseAllowance(bad));
});

test("collector preserves executable argument boundaries and sanitizes CLI errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "central-usage-"));
  try {
    const executable = join(dir, "central with spaces ' and quotes");
    writeFileSync(executable, `#!${process.execPath}\nif(JSON.stringify(process.argv.slice(2))!==JSON.stringify(['limit','--json']))process.exit(2);console.log(${JSON.stringify(JSON.stringify(allowance))});`, { mode: 0o700 });
    assert.equal((await collectUsage(executable)).status, "ok");
    writeFileSync(executable, `#!${process.execPath}\nconsole.error('fetch allowance: not logged in secret-token');process.exit(1);`);
    const auth = await collectUsage(executable);
    assert.equal(auth.status, "unauthenticated");
    assert.ok(!JSON.stringify(auth).includes("secret-token"));
    writeFileSync(executable, `#!${process.execPath}\nconsole.error('private-server-error secret-token');process.exit(1);`);
    assert.ok(!JSON.stringify(await collectUsage(executable)).includes("secret-token"));
    writeFileSync(executable, `#!${process.execPath}\nconsole.log('not JSON secret-token');`);
    assert.match((await collectUsage(executable)).message!, /unsupported/);
    assert.equal((await collectUsage(join(dir, "missing"))).status, "not_installed");
    writeFileSync(executable, `#!${process.execPath}\nsetInterval(()=>{},1000);`);
    const controller = new AbortController();
    const request = collectUsage(executable, controller.signal);
    controller.abort();
    assert.equal((await request).status, "error");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("quota cache shares concurrent requests per machine, refreshes on demand, and clears old credits after logout", async () => {
  let now = 1000, calls = 0;
  let value = parseAllowance(allowance, now);
  const cache = new UsageCache(async () => { calls++; await Promise.resolve(); return value; }, () => now);
  const [first, second] = await Promise.all([cache.get("a"), cache.get("a", true)]);
  assert.strictEqual(first, second);
  assert.equal(calls, 1);
  await cache.get("a"); assert.equal(calls, 1);
  await cache.get("b"); assert.equal(calls, 2);
  await cache.get("a", true); assert.equal(calls, 3);
  value = usageFailure("error", "offline"); now += 61_000;
  const stale = await cache.get("a");
  assert.equal(stale.stale, true); assert.equal(stale.observedAt, 1000);
  assert.equal(stale.balances[0].used, 7.02);
  await cache.get("a"); assert.equal(calls, 4);
  value = usageFailure("unauthenticated", "sign in");
  const loggedOut = await cache.get("a", true);
  assert.deepEqual(loggedOut.balances, []);
  value = parseAllowance(allowance, now);
  cache.markDirty("a"); await cache.get("a"); assert.equal(calls, 6);
});

test("host entry serves quota independently of a running agent bridge", async () => {
  const harness = experimental_createHostEntryHarness(hostEntry);
  try {
    const value = await harness.experimental_call("centralUsage", { command: "/missing/central" });
    assert.equal(value.status, "not_installed");
  } finally { await harness.experimental_dispose(); }
});

test("Provider usage inventory is cheap and shares one Central resource across agent profiles and context reads", async () => {
  const machine = makeHostResponse({ id: "host-test", name: "Work machine", status: "connected" });
  let collects = 0;
  const { bb, harness } = createFakePluginHost({
    experimental_hostEntry: true,
    sdk: {
      hosts: { list: async () => [machine], get: async () => machine },
      threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId,
        providerId: threadId === "personal" ? "codex" : threadId === "claude" ? "central-claude-code" : "central-codex", environmentId: "env-test" }) },
      environments: { get: async () => ({ hostId: machine.id }) },
    },
    experimental_callHostRpc: async ({ method, hostId }) => {
      assert.equal(method, "centralUsage"); assert.equal(hostId, machine.id);
      collects++; return parseAllowance(allowance, 1000);
    },
  });
  try {
    await plugin(bb);
    const inventory = await harness.behavior.callRpc("provider-usage.v1.listResources", {}) as any;
    assert.equal(inventory.resources.length, 1);
    assert.equal(inventory.resources[0].providerId, "central");
    assert.equal(collects, 0);
    assert.equal(await harness.behavior.callRpc("threadUsage", { threadId: "personal" }), null);
    assert.equal(collects, 0);
    await harness.behavior.callRpc("provider-usage.v1.getResource", { resourceId: inventory.resources[0].id, refresh: false });
    await harness.behavior.callRpc("threadUsage", { threadId: "work" });
    await harness.behavior.callRpc("threadUsage", { threadId: "claude" });
    assert.equal(collects, 1);
    await harness.behavior.callRpc("threadUsage", { threadId: "work", refresh: true });
    assert.equal(collects, 2);
    await harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ providerId: "central-codex", environmentId: "env-test" }), lastAssistantText: null });
    await harness.behavior.callRpc("threadUsage", { threadId: "work" });
    assert.equal(collects, 3);
    await assert.rejects(harness.behavior.callRpc("provider-usage.v1.getResource", { resourceId: '["host-test","codex"]', refresh: false }));
    assert.equal(collects, 3);
  } finally { await harness.lifecycle.dispose(); }
});
