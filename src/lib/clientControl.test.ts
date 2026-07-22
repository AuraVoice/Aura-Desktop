import { describe, expect, it, vi } from "vitest";
import { encodeGuideMode, publishGuideMode } from "./clientControl";

describe("guide.mode", () => {
  it("encodes the outbound client event contract", () => {
    const encoded = encodeGuideMode({
      active: true,
      guideSessionId: "0123456789abcdef0123456789abcdef",
      generation: 4,
    });
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual({
      type: "guide.mode",
      active: true,
      guide_session_id: "0123456789abcdef0123456789abcdef",
      generation: 4,
    });
  });

  it("publishes reliably on client_events", async () => {
    const publishData = vi.fn().mockResolvedValue(undefined);
    const room = { localParticipant: { publishData } };
    await publishGuideMode(room as never, {
      active: false,
      guideSessionId: null,
      generation: 5,
    });
    expect(publishData).toHaveBeenCalledWith(expect.any(Uint8Array), {
      reliable: true,
      topic: "client_events",
    });
  });
});
