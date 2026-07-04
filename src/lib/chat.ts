import { authFetch } from "./api";

export interface ChatAttachment {
  type: "image";
  mime_type: string;
  file_name: string;
  /** base64, no `data:` prefix */
  data: string;
}

export interface SendChatMessageArgs {
  message: string;
  attachments?: ChatAttachment[];
}

// TODO: the exact SSE payload shape from /chat is unconfirmed against the
// live backend (plain text per `data:` line vs a JSON-wrapped delta). This
// handles both: valid JSON with a text-ish field uses that field, anything
// else is treated as the literal token text. Revisit once confirmed.
function extractToken(data: string): string {
  try {
    const parsed = JSON.parse(data);
    if (typeof parsed === "string") return parsed;
    if (typeof parsed?.delta === "string") return parsed.delta;
    if (typeof parsed?.token === "string") return parsed.token;
    if (typeof parsed?.content === "string") return parsed.content;
    return "";
  } catch {
    return data;
  }
}

/**
 * POSTs to /chat and parses the SSE response incrementally, invoking
 * onToken for each chunk of text as it arrives rather than buffering to the
 * end.
 */
export async function streamChat(
  args: SendChatMessageArgs,
  onToken: (text: string) => void,
): Promise<void> {
  const response = await authFetch("/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: args.message,
      attachments: args.attachments ?? [],
    }),
  });

  if (!response.ok || !response.body) {
    throw new Error(`Chat request failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const rawEvent = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      const dataLines = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) continue;

      const data = dataLines.join("\n");
      if (data === "[DONE]") return;

      const token = extractToken(data);
      if (token) onToken(token);
    }
  }
}
