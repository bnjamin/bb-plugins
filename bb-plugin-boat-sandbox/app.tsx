import { useEffect, useState, useSyncExternalStore } from "react";
import { definePluginApp, useBbNavigate, useRpc, type PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { shareContract } from "./share-rpc.js";
import { shareErrorMessage } from "./share-errors.js";

type Preview = { url: string; origin: string };
type Request = { promise?: Promise<Preview>; opened?: boolean; settled?: boolean };
// Only explicit clicks start sharing. Restoring a persisted panel never starts an app.
// Keep the request across React remounts so one click creates one RPC/browser open.
const requests = new Map<string, Request>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function requestShare(threadId: string) {
  const previous = requests.get(threadId);
  if (previous && !previous.settled) return;
  requests.set(threadId, {});
  for (const listener of listeners) listener();
}

function SharePanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<typeof shareContract>();
  const navigate = useBbNavigate();
  const request = useSyncExternalStore(subscribe, () => requests.get(threadId));
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState("Share this thread’s app through Boat and open its private preview.");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!request) return;
    let active = true;
    setBusy(true); setError(undefined); setPreview(undefined);
    setStatus("Preparing your private preview… This can take up to two minutes.");
    request.promise ??= rpc.call("share", { threadId }).finally(() => { request.settled = true; });
    void request.promise.then((result) => {
      if (!active) return;
      setPreview(result); setBusy(false);
      if (!request.opened) {
        request.opened = true;
        setStatus(navigate.openUrl(result.url) ? "Private preview opened in your browser." : "Your preview is ready. Open it below.");
      } else setStatus("Your private preview is ready.");
    }).catch((error: unknown) => {
      if (!active) return;
      setBusy(false);
      setStatus("Your app could not be shared.");
      setError(shareErrorMessage(error));
    });
    return () => { active = false; };
  }, [request, threadId, rpc, navigate]);

  return <section style={{ display: "grid", gap: 12, fontSize: 14 }} aria-label="Share app">
    <h2 style={{ fontSize: 16, fontWeight: 600 }}>Share app</h2>
    <p role="status">{status}</p>
    {error && <p role="alert">{error}</p>}
    {preview && <>
      <p style={{ overflowWrap: "anywhere" }}>{preview.origin}/</p>
      <a href={preview.url} target="_blank" rel="noreferrer" onClick={(event) => {
        if (navigate.openUrl(preview.url)) event.preventDefault();
      }}>Open private preview</a>
      <p>Anyone with the private link can access this app. The link includes an access token.</p>
    </>}
    <button type="button" disabled={busy} onClick={() => requestShare(threadId)}
      style={{ border: "1px solid currentColor", borderRadius: 6, padding: "8px 12px", justifySelf: "start", opacity: busy ? 0.6 : 1 }}>
      {busy ? "Sharing…" : error ? "Retry sharing" : preview ? "Refresh preview" : "Share app"}
    </button>
  </section>;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "share", title: "Share app", icon: "Share2", component: SharePanel,
    run({ threadId, openPanel }) {
      if (openPanel()) requestShare(threadId);
    },
  });
});
