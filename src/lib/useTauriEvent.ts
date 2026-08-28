import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

import { logError } from "./log";

// The one subscribe-to-a-Tauri-event hook. The disposed guard is the point:
// listen() resolves asynchronously, so an unmount that wins the race would
// otherwise attach a native listener with nothing left to remove it. The
// handler lives in a ref, so callers can pass an inline closure without
// re-subscribing on every render.
export function useTauriEvent<T = unknown>(
  eventName: string,
  handler: (payload: T) => void,
  errorLabel?: string,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const errorLabelRef = useRef(errorLabel);
  errorLabelRef.current = errorLabel;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    listen<T>(eventName, (event) => handlerRef.current(event.payload))
      .then((fn) => {
        if (disposed) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((err) =>
        logError(errorLabelRef.current ?? `useTauriEvent: listen ${eventName}`, err),
      );
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [eventName]);
}

// Rust-owned state mirrored into React: subscribe to the change event FIRST,
// then load the current value, so a change landing between the two cannot be
// missed. An event that arrives while the load is in flight is newer and
// wins; null until the first value lands.
export function useTauriMirroredState<T>(
  eventName: string,
  load: () => Promise<T>,
  errorLabel?: string,
): T | null {
  const [value, setValue] = useState<T | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const errorLabelRef = useRef(errorLabel);
  errorLabelRef.current = errorLabel;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let eventArrived = false;
    void (async () => {
      try {
        const stop = await listen<T>(eventName, (event) => {
          eventArrived = true;
          if (!disposed) setValue(event.payload);
        });
        if (disposed) {
          stop();
          return;
        }
        unlisten = stop;
        const current = await loadRef.current();
        if (!disposed && !eventArrived) setValue(current);
      } catch (err) {
        logError(errorLabelRef.current ?? `useTauriMirroredState: ${eventName}`, err);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [eventName]);

  return value;
}
