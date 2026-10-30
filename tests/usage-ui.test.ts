import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { createElement } from "react";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { parseAllowance } from "../usage.js";
import { threadUsageContract } from "../usage-contract.js";
import type { ExperimentalThreadContextSegmentProps } from "@get-bb/plugin-sdk/app";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://bb.test/", pretendToBeVisual: true });
Object.defineProperties(globalThis, {
  window: { value: dom.window, configurable: true }, document: { value: dom.window.document, configurable: true },
  navigator: { value: dom.window.navigator, configurable: true }, HTMLElement: { value: dom.window.HTMLElement, configurable: true },
});
const value = parseAllowance({ usedDollars: "7.02", maxDollars: "200.00", licenseName: "JetBrains Team" });
const props: ExperimentalThreadContextSegmentProps = {
  threadId: "work", projectId: "project", environment: { id: "env" }, segments: [], isExpanded: true, onToggle() {},
};

test("Central banner and context card show rounded remaining credits; refresh uses the forced read", async () => {
  const app = await loadPluginApp(() => import("../app.js"));
  const segment = app.threadContextSegments[0];
  const slot = renderSlot({ component: segment.summary }, props, {
    experimental_rpcContract: threadUsageContract, rpc: { threadUsage: () => value },
  });
  try {
    await slot.findByText("Central: 193 / 200 credits left");
    assert.ok(!slot.container.textContent?.includes("$"));
  } finally { slot.lifecycle.unmount(); }
  const row = renderSlot(app.threadContextCardRows[0], props, {
    experimental_rpcContract: threadUsageContract, rpc: { threadUsage: () => value }, threadContextKind: "card",
  });
  try {
    await row.findByText(/193 \/ 200 credits left/);
    fireEvent.click(row.getByRole("button", { name: "Refresh Central credits" }));
    await waitFor(() => {
      assert.ok(row.inspection.rpcCalls.some(call => call.method === "threadUsage" && (call.input as any).refresh === true));
      assert.equal(row.getByRole("button", { name: "Refresh Central credits" }).hasAttribute("disabled"), false);
    });
  } finally { row.lifecycle.unmount(); }
});

test("banner is hidden in card mode and personal threads have no Central row", async () => {
  const app = await loadPluginApp(() => import("../app.js"));
  const segment = app.threadContextSegments[0];
  const slot = renderSlot({ component: (input: ExperimentalThreadContextSegmentProps) =>
    segment.useVisible?.(input) ? createElement(segment.summary, input) : null }, props, {
    threadContextKind: "card", experimental_rpcContract: threadUsageContract, rpc: { threadUsage: () => value },
  });
  try { assert.equal(slot.container.textContent, ""); assert.equal(slot.inspection.rpcCalls.length, 0); }
  finally { slot.lifecycle.unmount(); }
  const personal = renderSlot(app.threadContextCardRows[0], { ...props, threadId: "personal" }, {
    experimental_rpcContract: threadUsageContract, rpc: { threadUsage: () => null },
  });
  try {
    // Unknown/archived sidebar rows are resolved by the server, which returns null.
    await waitFor(() => assert.equal(personal.container.textContent, ""));
  } finally { personal.lifecycle.unmount(); }
});

test("stale credits retain their value and auth failures explain how to sign in", async () => {
  const app = await loadPluginApp(() => import("../app.js"));
  const slot = renderSlot({ component: app.threadContextSegments[0].details! }, props, {
    experimental_rpcContract: threadUsageContract,
    rpc: { threadUsage: () => ({ ...value, status: "error", stale: true, message: "Machine disconnected." }) },
  });
  try {
    await slot.findByText("Data may be out of date. Refresh to retry.");
    assert.ok(slot.container.textContent?.includes("193 / 200 credits left"));
  } finally { slot.lifecycle.unmount(); }
  const auth = renderSlot({ component: app.threadContextSegments[0].summary }, props, {
    experimental_rpcContract: threadUsageContract,
    rpc: { threadUsage: () => ({ ...value, status: "unauthenticated", balances: [], observedAt: null,
      message: "Run central login on this machine." }) },
  });
  try { await auth.findByText("Central: Sign in to Central"); }
  finally { auth.lifecycle.unmount(); }
});
