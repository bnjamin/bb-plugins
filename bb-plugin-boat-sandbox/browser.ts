import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type BrowserTarget = {
  threadId: string;
  browserHost?: string | undefined;
  browserInstance?: string | undefined;
};

/**
 * `matched` is the number of connected desktop windows the filters selected, or
 * null when BB could not be asked at all. Callers word their own message from it,
 * because "no window" and "BB is unreachable" are different things to a user.
 */
export type BrowserReveal = {
  browser: "opened" | "reused" | "unavailable";
  matched: number | null;
  browserTarget: { hostId: string; instanceId: string } | null;
};

/**
 * Show `url` in the thread's browser panel, reusing a tab already on that origin.
 * A private URL carries a single-use token that the app strips on redirect, so
 * tabs are matched by origin rather than by href.
 */
export async function revealUrl(bb: BbPluginApi, url: string, target: BrowserTarget): Promise<BrowserReveal> {
  try {
    const hosts = await bb.sdk.hosts.list();
    const instances = (await Promise.all(hosts
      .filter(h => h.status === "connected" && (!target.browserHost || h.id === target.browserHost))
      .map(async h => (await bb.sdk.experimental_desktopBrowsers.listInstances({ hostId: h.id })).instances))).flat()
      .filter(i => !target.browserInstance || i.instanceId === target.browserInstance);
    if (instances.length !== 1) return { browser: "unavailable", matched: instances.length, browserTarget: null };
    const instance = instances[0]!;
    const scope = { hostId: instance.hostId, instanceId: instance.instanceId, generation: instance.generation, threadId: target.threadId };
    const tabs = await bb.sdk.experimental_desktopBrowsers.listTabs(scope);
    const tab = tabs.tabs.find(t => { try { return new URL(t.url).origin === new URL(url).origin; } catch { return false; } });
    if (tab) await bb.sdk.experimental_desktopBrowsers.revealTab({ ...scope, tabId: tab.tabId });
    else await bb.sdk.experimental_desktopBrowsers.createTab({ ...scope, url, presentation: "reveal" });
    return { browser: tab ? "reused" : "opened", matched: 1, browserTarget: { hostId: instance.hostId, instanceId: instance.instanceId } };
  } catch { return { browser: "unavailable", matched: null, browserTarget: null }; }
}
