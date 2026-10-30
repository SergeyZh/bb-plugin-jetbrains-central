import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { CentralUsage, CreditBalance } from "./usage-contract.js";

const execute = promisify(execFile);
const amount = z.union([z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number), z.number()]).pipe(z.number().finite().nonnegative());
const quota = z.object({ current: amount, maximum: amount, available: amount });
const allowance = z.object({
  email: z.string().optional(), licenseName: z.string().optional(),
  usedDollars: amount.optional(), maxDollars: amount.optional(),
  tariffQuota: quota.optional(), topUpQuota: quota.optional(),
  refillNext: z.number().int().nonnegative().nullable().optional(),
});

export function usageFailure(status: "error" | "unauthenticated" | "not_installed", message: string): CentralUsage {
  return { status, message, accountEmail: null, planLabel: null, balances: [], observedAt: null, stale: false };
}

export function parseAllowance(input: unknown, now = Date.now()): CentralUsage {
  const value = allowance.parse(input);
  const reset = value.refillNext ? new Date(value.refillNext).toISOString() : null;
  const balances: CreditBalance[] = [];
  if (value.tariffQuota) {
    balances.push({ id: "tariff", label: "Central", used: value.tariffQuota.current,
      limit: value.tariffQuota.maximum, available: value.tariffQuota.available, resetsAt: reset });
  } else if (value.usedDollars !== undefined && value.maxDollars !== undefined) {
    balances.push({ id: "tariff", label: "Central", used: value.usedDollars,
      limit: value.maxDollars, available: Math.max(0, value.maxDollars - value.usedDollars), resetsAt: reset });
  } else {
    throw new Error("Central returned no credit allowance.");
  }
  if (value.topUpQuota && (value.topUpQuota.maximum > 0 || value.topUpQuota.current > 0 || value.topUpQuota.available > 0)) {
    balances.push({ id: "top-up", label: "Top-up", used: value.topUpQuota.current,
      limit: value.topUpQuota.maximum, available: value.topUpQuota.available, resetsAt: null });
  }
  return { status: "ok", accountEmail: value.email || null, planLabel: value.licenseName || null,
    balances, observedAt: now, stale: false, message: null };
}

export async function collectUsage(command: string, signal?: AbortSignal): Promise<CentralUsage> {
  let stdout: string;
  try {
    ({ stdout } = await execute(command, ["limit", "--json"], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 256 * 1024, signal, windowsHide: true, killSignal: "SIGKILL",
    }));
  } catch (error) {
    const failure = error as { code?: string; stderr?: string; killed?: boolean };
    // Inspect, but never forward stderr: it may contain account or token data.
    if (/not logged in|unauthenticated|login required|unauthorized|\b401\b/i.test(failure.stderr ?? "")) {
      return usageFailure("unauthenticated", "Run central login on this machine, then refresh Central credits.");
    }
    if (failure.code === "ENOENT") return usageFailure("not_installed", "Central is not installed on this machine.");
    return usageFailure("error", signal?.aborted ? "Central usage request was cancelled." : failure.killed
      ? "Central usage request timed out." : "Central usage could not be collected from this machine.");
  }
  try { return parseAllowance(JSON.parse(stdout)); }
  catch { return usageFailure("error", "Central returned an unsupported credit allowance response."); }
}

// One cache per plugin generation and configured command, keyed by machine.
// Failed attempts are throttled too; a manual refresh always retries.
export class UsageCache {
  private values = new Map<string, { value: CentralUsage; checkedAt: number }>();
  private pending = new Map<string, Promise<CentralUsage>>();
  constructor(private collect: (hostId: string) => Promise<CentralUsage>, private now = Date.now) {}
  async get(hostId: string, refresh = false): Promise<CentralUsage> {
    const pending = this.pending.get(hostId);
    if (pending) return pending;
    const previous = this.values.get(hostId);
    if (!refresh && previous && this.now() - previous.checkedAt < (previous.value.status === "ok" ? 60_000 : 15_000)) return previous.value;
    const request = this.collect(hostId).catch(() => usageFailure("error", "Central usage could not be collected from this machine.")).then(value => {
      if (value.status === "error" && previous?.value.observedAt !== null && previous?.value.balances.length) {
        value = { ...value, accountEmail: previous.value.accountEmail, planLabel: previous.value.planLabel,
          balances: previous.value.balances, observedAt: previous.value.observedAt, stale: true };
      }
      this.values.set(hostId, { value, checkedAt: this.now() });
      return value;
    }).finally(() => this.pending.delete(hostId));
    this.pending.set(hostId, request);
    return request;
  }
  invalidate(hostId: string) { this.values.delete(hostId); }
  markDirty(hostId: string) {
    const previous = this.values.get(hostId);
    if (previous) previous.checkedAt = -Infinity;
  }
}
