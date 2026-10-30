import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const balanceSchema = z.object({
  id: z.enum(["tariff", "top-up"]), label: z.string(),
  used: z.number().nonnegative(), limit: z.number().nonnegative(), available: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
});
export const centralUsageSchema = z.object({
  status: z.enum(["ok", "unauthenticated", "not_installed", "error"]),
  accountEmail: z.string().nullable(), planLabel: z.string().nullable(),
  balances: z.array(balanceSchema), observedAt: z.number().nullable(),
  stale: z.boolean(), message: z.string().nullable(),
});
export type CentralUsage = z.infer<typeof centralUsageSchema>;
export type CreditBalance = z.infer<typeof balanceSchema>;

export const usageHostContract = defineRpcContract({
  centralUsage: {
    input: z.object({ command: z.string().min(1) }), output: centralUsageSchema,
    experimental_retryable: true,
  },
});
export const threadUsageContract = defineRpcContract({
  threadUsage: {
    input: z.object({ threadId: z.string().min(1), refresh: z.boolean().default(false) }),
    output: centralUsageSchema.nullable(),
  },
});

// Provider usage's discoverable v1 wire contract. Credits deliberately never
// enter its USD-only cost field. A dedicated resource represents all agents.
const usageWindow = z.object({
  id: z.string(), kind: z.literal("custom"), label: z.string(), usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(), model: z.null(), cost: z.null(),
});
const identity = { accountEmail: z.string().nullable(), planLabel: z.string().nullable(), plan: z.null() };
export const sourceMeasurementSchema = z.object({
  accountKey: z.null(), observedAt: z.number().nullable(),
  usage: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), ...identity, windows: z.array(usageWindow) }),
    z.object({ status: z.literal("unauthenticated"), ...identity }),
    z.object({ status: z.literal("not_installed"), ...identity }),
    z.object({ status: z.literal("error"), ...identity, message: z.string() }),
  ]),
});
export const usageSourceContract = defineRpcContract({
  "provider-usage.v1.listResources": {
    input: z.object({}),
    output: z.object({ resources: z.array(z.object({
      id: z.string(), providerId: z.string(), label: z.string(), accountKey: z.null(),
      scope: z.object({ kind: z.literal("host"), hostId: z.string(), hostName: z.string() }),
    })) }),
  },
  "provider-usage.v1.getResource": {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }), output: sourceMeasurementSchema,
  },
});

export function credits(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function balanceLabel(balance: CreditBalance): string {
  return `${balance.label}: ${credits(balance.used)} / ${credits(balance.limit)} credits`;
}
export function sourceMeasurement(value: CentralUsage): z.infer<typeof sourceMeasurementSchema> {
  const common = { accountEmail: value.accountEmail, planLabel: value.planLabel, plan: null };
  const usage = value.status === "ok" ? {
    ...common, status: "ok" as const,
    windows: value.balances.map(balance => ({
      id: balance.id, kind: "custom" as const, label: balanceLabel(balance),
      usedPercent: balance.limit > 0 ? balance.used / balance.limit * 100 : balance.used > 0 ? 100 : 0,
      resetsAt: balance.resetsAt, model: null, cost: null,
    })),
  } : value.status === "error" ? {
    ...common, status: "error" as const, message: value.message ?? "Central usage could not be collected.",
  } : { ...common, status: value.status };
  // Central exposes an email, but no authoritative quota-account identifier.
  // Unknown accounts must not be merged across hosts on the basis of email.
  return sourceMeasurementSchema.parse({ accountKey: null, observedAt: value.observedAt, usage });
}
