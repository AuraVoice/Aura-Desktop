import { useState } from "react";
import { useVoiceSession } from "../hooks/useVoiceSession";
import { captureScreenshot } from "../lib/screenshot";
import { streamChat } from "../lib/chat";
import { AuthRequiredError, routeToDashboardForExpiredSession } from "../lib/api";
import { logError } from "../lib/log";
import "./AvatarView.css";

function AvatarView() {
  const { status, error } = useVoiceSession();
  const [reply, setReply] = useState("");
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);

  async function handleCapture() {
    setCapturing(true);
    setCaptureError(null);
    setReply("");
    try {
      const data = await captureScreenshot();
      await streamChat(
        {
          message: "",
          attachments: [
            {
              type: "image",
              mime_type: "image/jpeg",
              file_name: "screenshot.jpg",
              data,
            },
          ],
        },
        (token) => setReply((prev) => prev + token),
      );
    } catch (err) {
      if (err instanceof AuthRequiredError) {
        await routeToDashboardForExpiredSession();
        return;
      }
      logError("AvatarView: handleCapture", err);
      setCaptureError("Couldn't get a reply. Try again.");
    } finally {
      setCapturing(false);
    }
  }

  return (
    <div className="avatar-view" data-tauri-drag-region>
      <div className={`avatar-orb avatar-orb--${status}`} data-tauri-drag-region>
        <span className="avatar-orb-glow" />
      </div>
      <button
        type="button"
        className="avatar-capture-button"
        onClick={handleCapture}
        disabled={capturing}
        title="Ask about your screen"
      >
        {capturing ? "..." : "Ask"}
      </button>
      {status === "error" && error && <p className="avatar-error">{error}</p>}
      {(reply || captureError) && (
        <div className="avatar-bubble">
          {captureError ?? reply}
        </div>
      )}
    </div>
  );
}

export default AvatarView;
