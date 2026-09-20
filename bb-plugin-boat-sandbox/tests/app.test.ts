import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://bb.example" });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
const { loadPluginApp, renderSlot } = await import("@get-bb/plugin-sdk/testing/app");
const { act, fireEvent } = await import("@testing-library/react");
const app = await loadPluginApp(() => import("../app.js"));
const action = app.threadPanelActions[0]!;
const preview = { url: "https://app.on.boat.dev/?_token=private", origin: "https://app.on.boat.dev" };

test("sidebar action shares once through remounts and repeated pending clicks, opens the current client", async () => {
  let finish!: (value: typeof preview) => void;
  let calls = 0;
  const rpc = { share: async () => { calls++; return new Promise<typeof preview>((resolve) => { finish = resolve; }); } };
  const run = () => action.run!({ threadId: "one", openPanel: () => true });
  await run();
  const first = renderSlot(action, { threadId: "one", params: null }, { rpc });
  assert.equal(calls, 1);
  first.unmount();
  const second = renderSlot(action, { threadId: "one", params: null }, { rpc });
  await act(async () => { await run(); });
  assert.equal(calls, 1);
  await act(async () => { finish(preview); });
  assert.equal(second.inspection.navigateCalls.length, 1);
  assert.equal(second.getByRole("link").getAttribute("href"), preview.url);
  assert.doesNotMatch(second.container.textContent!, /_token/);
  second.unmount();
  const third = renderSlot(action, { threadId: "one", params: null }, { rpc });
  await third.findByText("Your private preview is ready.");
  assert.equal(calls, 1);
  assert.equal(third.inspection.navigateCalls.length, 0);
  third.unmount();
});

test("restored panel is idle; failures can retry and declined browser opens leave a link", async () => {
  let calls = 0;
  const slot = renderSlot(action, { threadId: "two", params: null }, {
    rpc: { share: async () => { if (++calls === 1) throw new Error("private error"); return preview; } },
    openUrl: () => false,
  });
  assert.equal(calls, 0);
  fireEvent.click(slot.getByRole("button", { name: "Share app" }));
  await slot.findByRole("alert");
  assert.doesNotMatch(slot.container.textContent!, /private error/);
  fireEvent.click(slot.getByRole("button", { name: "Retry sharing" }));
  await slot.findByText("Your preview is ready. Open it below.");
  assert.equal(calls, 2);
  assert.equal(slot.getByRole("link").getAttribute("href"), preview.url);
  slot.unmount();
});
