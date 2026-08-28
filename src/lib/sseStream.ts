/** Byte -> raw SSE frame splitter shared by chatStream.ts and
 * interviewHackerApi's readEventStream: CRLF normalized, frames split on
 * blank lines, the unterminated tail flushed at end of stream. Frame PARSING
 * stays with each caller (chat frames are data-only; research frames carry
 * event:/comment lines). streamInterviewAnswer keeps its own in-file copy on
 * purpose - see the note above it in interviewHackerApi.ts. */
export async function readSseFrames(
  body: ReadableStream<Uint8Array>,
  onRawFrame: (rawFrame: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, "\n");
      let separator = buffer.indexOf("\n\n");
      while (separator >= 0) {
        onRawFrame(buffer.slice(0, separator));
        buffer = buffer.slice(separator + 2);
        separator = buffer.indexOf("\n\n");
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.trim()) onRawFrame(buffer);
}
