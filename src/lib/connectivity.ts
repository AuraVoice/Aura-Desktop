// One place that knows whether the machine has a network at all, so the paths
// a user actually watches (chat send, call start, a dictation hold) can say
// "you're offline" up front instead of spinning into a generic transport
// error. `navigator.onLine` is optimistic: true on a captive portal or a dead
// link the OS has not noticed yet, so a false here is trustworthy and a true
// only means "not known to be offline". Nothing here imports Tauri; the
// dashboard window can use it too.

import { useEffect, useState } from "react";

export class OfflineError extends Error {
  constructor() {
    super("offline");
    this.name = "OfflineError";
  }
}

export function isOnline(): boolean {
  if (typeof navigator === "undefined") return true;
  return navigator.onLine !== false;
}

/** Called with the new state on every change. Returns the unsubscribe. */
export function subscribeOnline(listener: (online: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => listener(true);
  const onOffline = () => listener(false);
  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);
  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
  };
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(isOnline);
  useEffect(() => subscribeOnline(setOnline), []);
  return online;
}
