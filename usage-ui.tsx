import { useEffect, useState } from "react";
import {
  experimental_Icon as Icon, experimental_ThreadContextCardRow as ContextRow,
  experimental_useRpcQuery, experimental_useSidebarThreads, useRpc,
  type ExperimentalThreadContextCardProps, type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import { balanceLabel, credits, threadUsageContract, type CentralUsage } from "./usage-contract.js";

export function useCentralThread(threadId: string): boolean {
  const { threads } = experimental_useSidebarThreads({ experimental_lifecycles: ["active", "archived"] });
  const thread = threads.find(value => value.id === threadId);
  // A thread may not be in the sidebar yet. The server checks its exact provider.
  return !thread || thread.providerId.startsWith("central-");
}

function useUsage(threadId: string) {
  const enabled = useCentralThread(threadId);
  const query = experimental_useRpcQuery({ contract: threadUsageContract, method: "threadUsage", input: { threadId, refresh: false }, enabled });
  const rpc = useRpc<typeof threadUsageContract>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const refetch = query.refetch;
  useEffect(() => {
    if (!enabled) return;
    const tick = () => { if (document.visibilityState === "visible") void refetch(); };
    const timer = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", tick); };
  }, [enabled, refetch]);
  return {
    value: enabled ? query.data : null, error: query.error !== null || refreshError, refreshing: refreshing || query.isFetching,
    async refresh() {
      if (refreshing) return;
      setRefreshing(true);
      setRefreshError(false);
      try { await rpc.call("threadUsage", { threadId, refresh: true }); await refetch(); }
      catch { setRefreshError(true); }
      finally { setRefreshing(false); }
    },
  };
}

export function usageSummary(value: CentralUsage | undefined, error = false): string {
  if (!value) return error ? "Credits unavailable" : "Loading credits…";
  const balance = value.balances[0];
  if (balance) return `${credits(balance.available)} / ${credits(balance.limit)} credits left${value.stale || error ? " · stale" : ""}`;
  return value.status === "unauthenticated" ? "Sign in to Central" : value.status === "not_installed" ? "Central not installed" : "Credits unavailable";
}

function usageTitle(value: CentralUsage | undefined, error: boolean): string {
  if (!value) return error ? "Central credits could not be loaded. Refresh to retry." : "Loading Central credits";
  return [value.planLabel, ...value.balances.map(balance => `${balanceLabel(balance)}${balance.resetsAt ? `; resets ${new Date(balance.resetsAt).toLocaleString()}` : ""}`),
    value.message, value.observedAt ? `Updated ${new Date(value.observedAt).toLocaleString()}` : null,
    error || value.stale ? "Data may be out of date." : null].filter(Boolean).join("\n");
}

export function CentralUsageSummary({ threadId, onToggle, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { value, error } = useUsage(threadId);
  if (value === null) return null;
  return <button type="button" onClick={onToggle} aria-expanded={isExpanded} title={usageTitle(value, error)} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
    <Icon name="ChartColumn" className="size-3.5 shrink-0" />
    <span className="truncate">Central: {usageSummary(value, error)}</span>
  </button>;
}

export function CentralUsageDetails({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const { value, error, refreshing, refresh } = useUsage(threadId);
  if (!isExpanded || value === null) return null;
  return <div className="space-y-2 p-3 text-xs text-muted-foreground">
    <div className="flex items-center justify-between gap-3"><span>{value?.planLabel ?? "JetBrains Central"}</span>
      <button type="button" disabled={refreshing} onClick={() => void refresh()} className="hover:text-foreground disabled:opacity-50">{refreshing ? "Refreshing…" : "Refresh credits"}</button></div>
    {value?.balances.map(balance => <div key={balance.id}>
      <div>{balanceLabel(balance)}</div>
      {balance.resetsAt ? <div>Resets {new Date(balance.resetsAt).toLocaleString()}</div> : null}
    </div>)}
    {value?.message ? <p>{value.message}</p> : null}
    {error || value?.stale ? <p>Data may be out of date. Refresh to retry.</p> : null}
    {value?.observedAt ? <p>Updated {new Date(value.observedAt).toLocaleString()}. Shared by all Central agents on this machine.</p> : null}
  </div>;
}

export function CentralUsageRow({ threadId }: ExperimentalThreadContextCardProps) {
  const { value, error, refreshing, refresh } = useUsage(threadId);
  if (value === null) return null;
  return <ContextRow icon="ChartColumn" label="Central credits" trailing={usageSummary(value, error)} title={usageTitle(value, error)}
    action={<button type="button" aria-label="Refresh Central credits" disabled={refreshing} onClick={() => void refresh()} title="Refresh Central credits">
      <Icon name="RotateCcw" className={`size-3.5${refreshing ? " animate-spin" : ""}`} />
    </button>} />;
}
