import { fetch as pluginFetch } from "@tauri-apps/plugin-http";

/**
 * plugin-http's fetch, minus its stray cancels. The plugin adds a listener to
 * the caller's AbortSignal and never removes it, so aborting that signal after
 * the request finished still asks Rust to cancel ids it already freed: one
 * unhandled "The resource id N is invalid." per request, two with a body. A
 * signal shared by many requests (a poll walk, a voice call, a page's cleanup)
 * fired them all at once, 319 of them in one log.
 *
 * Here the plugin gets a signal of its own that follows the caller's only until
 * the response headers arrive, while its request id is still live. After that
 * a caller's abort cancels the body stream instead, which frees the body
 * through the plugin's own cancel path, and once the body ends the caller's
 * signal is let go entirely. Streams (chat, interview research) still stop the
 * moment their signal aborts.
 */
export async function fetch(input: string, init?: RequestInit): Promise<Response> {
  const outer = init?.signal;
  if (!outer) return pluginFetch(input, init);

  const inner = new AbortController();
  const forward = () => inner.abort(outer.reason);
  if (outer.aborted) inner.abort(outer.reason);
  else outer.addEventListener("abort", forward, { once: true });

  let response: Response;
  try {
    response = await pluginFetch(input, { ...init, signal: inner.signal });
  } finally {
    outer.removeEventListener("abort", forward);
  }
  if (!response.body) return response;

  const reader = response.body.getReader();
  let stopBody: (() => void) | null = null;
  const release = () => {
    if (stopBody) outer.removeEventListener("abort", stopBody);
    stopBody = null;
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stopBody = () => {
        release();
        controller.error(outer.reason);
        void reader.cancel(outer.reason).catch(() => undefined);
      };
      if (outer.aborted) stopBody();
      else outer.addEventListener("abort", stopBody, { once: true });
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        release();
        controller.error(err);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason);
    },
  });

  const wrapped = new Response(body, { status: response.status, statusText: response.statusText });
  // Neither can be set through the constructor, which would also drop the
  // set-cookie header the plugin deliberately keeps.
  Object.defineProperty(wrapped, "url", { value: response.url, writable: false });
  Object.defineProperty(wrapped, "headers", { value: response.headers, writable: false });
  return wrapped;
}
