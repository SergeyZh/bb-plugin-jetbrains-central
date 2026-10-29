import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { experimental_defineProviderBridge, PROVIDER_BRIDGE_PROTOCOL_VERSION, skillsConfigureParamsSchema, type ProviderBridgeContext } from "@get-bb/plugin-sdk/provider-bridge";
import { experimental_acpProviderBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
import { z } from "zod";
import { profileSchema, centralArgs } from "./profiles.js";
import { findNativeBridge, claudeWrapper, nativeLaunchEnv, codexWrapper, resolveOnPath, runner } from "./native.js";
import { piModels, isWorkPiModel } from "./pi.js";

const launchSchema = z.object({ centralProfile: profileSchema, centralCommand: z.string().min(1), builtinPluginsDirectory: z.string().default("") });
let context: ProviderBridgeContext;
let child: ChildProcess | undefined;
let transport: "native" | "acp" = "native";
let selectedOptions: Record<string, unknown> = {};
let initializeLine = "";
let initializeId: unknown;
let ready = false;
let deferredSkills: ReturnType<typeof skillsConfigureParamsSchema.parse> | undefined;
const skillsReplayId = `central-skills-${randomUUID()}`;
let closed = false;
const lifecycle = new AbortController();
const waiting = new Set<unknown>();
const pending: string[] = [];
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\n");
const failure = (id: unknown, message: string) => send({jsonrpc: "2.0", id, error: {code: -32000, message}});
function flushPending() {
  ready = true;
  for (const queued of pending.splice(0)) child!.stdin!.write(queued + "\n");
}
function rewrite(message: any, nativeId: string) {
  if (message.params?.providerId) message.params.providerId = nativeId;
  if (transport === "acp" && message.params) {
    if (message.params.options) message.params.options.providerOptions = {...message.params.options.providerOptions, ...selectedOptions};
    else message.params.providerOptions = {...message.params.providerOptions, ...selectedOptions};
  }
  return JSON.stringify(message);
}
function stop() {
  closed = true;
  lifecycle.abort();
  child?.kill("SIGTERM");
  const processToKill = child;
  setTimeout(() => { if (processToKill && processToKill.exitCode === null) processToKill.kill("SIGKILL"); }, 2000).unref();
}
const centralBridge = experimental_defineProviderBridge({
  start(ctx) { context = ctx; },
  async handleLine(line) {
    if (closed) return;
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === "initialize") {
      initializeLine = line; initializeId = message.id;
      send({jsonrpc: "2.0", id: message.id, result: {protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION, capabilities: {
        grammarVersions: [2, 3], approvalEnforcedBy: "provider", fork: "checkpoint", sessionRestore: true,
        steerMode: "inject", skills: {configure: true}, commands: {list: true}, threadArchive: true, threadRename: true,
      }}});
      return;
    }
    const options = message.params?.options?.providerOptions ?? message.params?.providerOptions;
    try {
      // BB configures injected skills before sending any provider launch options.
      // Save this host-level setup and apply it before the first session request.
      if (message.method === "skills/configure" && !child) {
        deferredSkills = skillsConfigureParamsSchema.parse(message.params);
        send({jsonrpc: "2.0", id: message.id, result: {ok: true}});
        return;
      }
      if (message.method === "provider/health") {
        send({jsonrpc: "2.0", id: message.id, result: {supported: false}});
        return;
      }
      if (options?.centralProfile?.bridge === "pi") {
        const launch = launchSchema.parse(options);
        if (message.method === "model/list") {
          const models = await piModels(launch.centralCommand, launch.centralProfile, lifecycle.signal);
          if (!closed) send({jsonrpc: "2.0", id: message.id, result: {models, selectedOnlyModels: []}});
          return;
        }
        const execution = message.params?.options;
        if (execution) {
          if (!execution.model && ["thread/start", "thread/resume", "thread/fork"].includes(message.method)) {
            const models = await piModels(launch.centralCommand, launch.centralProfile, lifecycle.signal);
            execution.model = models.find(m => m.isDefault)!.model;
          }
          if (execution.model && !isWorkPiModel(execution.model)) throw new Error("Select an OpenAI, Anthropic or Google Vertex model routed by Central for Pi");
        }
      }
      if (closed) return;
      if (message.method && message.id !== undefined) waiting.add(message.id);
      if (!child) {
        const launch = launchSchema.parse(options);
        const profile = launch.centralProfile;
        transport = profile.bridge === "acp" ? "acp" : "native";
        const modulePath = transport === "acp" ? fileURLToPath(import.meta.url) : findNativeBridge(profile.bridge, launch.builtinPluginsDirectory);
        const dataDir = join(context.dataDir, profile.id);
        mkdirSync(join(dataDir, "codex"), {recursive: true, mode: 0o700});
        const wrapper = join(context.tempDir, `central-${profile.id}`);
        writeFileSync(wrapper, claudeWrapper(launch.centralCommand, profile), {mode: 0o700});
        const env: NodeJS.ProcessEnv = {...process.env, ...(transport === "native" ? nativeLaunchEnv(profile, launch.centralCommand, wrapper, dataDir) : {CENTRAL_ACP_CHILD: "1"}),
          CENTRAL_NATIVE_BRIDGE: modulePath, CENTRAL_BRIDGE_CONTEXT: JSON.stringify(context)};
        if (profile.bridge === "codex") {
          const bin = join(context.tempDir, `bin-${profile.id}`);
          mkdirSync(bin, {recursive: true, mode: 0o700});
          writeFileSync(join(bin, "codex"), codexWrapper(resolveOnPath("codex"), process.env.PATH ?? "", join(dataDir, "codex")), {mode: 0o700});
          env.PATH = bin + ":" + (process.env.PATH ?? "");
        }
        if (transport === "acp") selectedOptions = {
          acpLaunchSpec: {displayName: profile.displayName, command: launch.centralCommand, args: centralArgs(profile, []), env: {}}, acpDialect: "acp",
        };
        // Prevent inherited account-pool routing from taking precedence over Central.
        delete env.CODEX_OPENAI_BASE_URL; delete env.CODEX_POOL_AUTH_TOKEN;
        child = spawn(process.execPath, ["--input-type=module", "-e", runner], {env, stdio: ["pipe", "pipe", "pipe"]});
        const nativeId = profile.bridge;
        createInterface({input: child.stdout!, crlfDelay: Infinity}).on("line", output => {
          let value: any;
          try { value = JSON.parse(output); } catch { return; }
          if (value.id === initializeId && !value.method && !ready) {
            if (value.error) { failure(message.id, "BB native bridge initialization failed"); return; }
            if (deferredSkills) {
              child!.stdin!.write(JSON.stringify({jsonrpc: "2.0", id: skillsReplayId, method: "skills/configure", params: deferredSkills}) + "\n");
            } else flushPending();
          } else if (value.id === skillsReplayId && !value.method) {
            if (value.error) {
              for (const id of waiting) failure(id, "Could not apply BB skills to the Central provider: " + value.error.message);
              waiting.clear(); stop(); return;
            }
            deferredSkills = undefined;
            flushPending();
          } else {
            if (!value.method) waiting.delete(value.id);
            process.stdout.write(output + "\n");
          }
        });
        // Drain without forwarding raw agent stderr (which can contain credentials).
        child.stderr!.resume();
        child.on("error", () => { for (const id of waiting) failure(id, "Could not launch BB native bridge"); waiting.clear(); });
        child.stdin!.on("error", () => { for (const id of waiting) failure(id, "Central provider input closed"); waiting.clear(); });
        child.on("exit", code => {
          if (!closed) {
            for (const id of waiting) failure(id, `Central provider bridge exited (${code ?? "signal"})`);
            waiting.clear(); process.exitCode = 1; process.stdin.destroy();
          }
        });
        child.stdin!.write(initializeLine + "\n");
        pending.push(rewrite(message, nativeId));
        return;
      }
      const nativeId = options?.centralProfile?.bridge;
      const serialized = nativeId ? rewrite(message, nativeId) : line;
      if (ready) child!.stdin!.write(serialized + "\n"); else pending.push(serialized);
    } catch (error) {
      waiting.delete(message.id);
      if (!closed) failure(message.id, error instanceof Error ? error.message : "Central launch failed");
    }
  },
  onClose: stop, onSigterm: stop, onSigint: stop,
});
export const experimental_providerBridge = process.env.CENTRAL_ACP_CHILD === "1" ? experimental_acpProviderBridge : centralBridge;
