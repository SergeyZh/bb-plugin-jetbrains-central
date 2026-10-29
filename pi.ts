import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Profile } from "./profiles.js";
import { centralArgs } from "./profiles.js";
import type { AvailableModel } from "@get-bb/plugin-sdk/provider-bridge";

export const CENTRAL_PI_PROVIDERS = new Set(["openai", "anthropic", "google-vertex"]);
export function isWorkPiModel(id: string) { return CENTRAL_PI_PROVIDERS.has(id.split("/")[0]); }
export async function piModels(command: string, profile: Profile, signal?: AbortSignal) {
  signal?.throwIfAborted();
  return await new Promise<AvailableModel[]>((resolve, reject) => {
    const child = spawn(command, centralArgs(profile, ["--mode", "rpc"]), {stdio: ["pipe", "pipe", "pipe"]});
    let settled = false;
    function finish(error?: Error, models?: AvailableModel[]) {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener("abort", onAbort); child.kill("SIGTERM");
      const kill = setTimeout(() => child.kill("SIGKILL"), 2000); kill.unref();
      child.once("exit", () => clearTimeout(kill));
      error ? reject(error) : resolve(models!);
    }
    const timer = setTimeout(() => finish(new Error("Central Pi model discovery timed out")), 15000);
    const onAbort = () => finish(new Error("Central Pi model discovery cancelled"));
    signal?.addEventListener("abort", onAbort, {once: true});
    child.on("error", () => finish(new Error("Could not start Central Pi")));
    child.on("exit", () => { if (!settled) finish(new Error("Central Pi exited during model discovery")); });
    child.stderr.resume();
    createInterface({input: child.stdout, crlfDelay: Infinity}).on("line", line => {
      let response;
      try { response = JSON.parse(line); } catch { return; }
      if (response.id !== "central-models" || response.type !== "response") return;
      if (!response.success || !Array.isArray(response.data?.models)) return finish(new Error("Central Pi could not list models"));
      const models = response.data.models.filter((m: any) => CENTRAL_PI_PROVIDERS.has(m.provider) && typeof m.id === "string")
        .map((m: any): AvailableModel => ({
          id: `${m.provider}/${m.id}`, model: `${m.provider}/${m.id}`, displayName: m.name || m.id,
          description: `${m.provider} via JetBrains Central`, isDefault: false,
          supportedReasoningEfforts: (m.reasoning ? ["none", "low", "medium", "high"] : ["none"]).map(reasoningEffort => ({reasoningEffort, description: reasoningEffort})),
          defaultReasoningEffort: m.reasoning ? "medium" : "none",
        }));
      if (!models.length) return finish(new Error("Central Pi returned no work models"));
      const preferred = models.find((m: any) => m.id === "anthropic/claude-sonnet-4-6") ?? models[0];
      preferred.isDefault = true;
      finish(undefined, models);
    });
    child.stdin.on("error", () => finish(new Error("Central Pi input closed")));
    child.stdin.write(JSON.stringify({id: "central-models", type: "get_available_models"}) + "\n");
  });
}
