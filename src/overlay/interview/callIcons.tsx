/**
 * Brand marks for the calling apps the Interview Companion can attach to.
 *
 * Inline SVG for the same reason src/dashboard/components/channelIcons.tsx is:
 * icon libraries ship no brand logos. Kept in the overlay's own folder because
 * the overlay bundle carries zero dashboard imports and should not grow one.
 *
 * App ids come from src-tauri/src/meeting/detect.rs (meeting_app_for_window).
 */

function ZoomMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#2D8CFF" />
      <path
        d="M6 9.4c0-.5.4-.9.9-.9h5.4c1 0 1.9.8 1.9 1.9v3.2c0 .5-.4.9-.9.9H7.9c-1 0-1.9-.8-1.9-1.9V9.4Zm9.9 1.7 2.3-1.6c.3-.2.8 0 .8.4v4.2c0 .4-.5.6-.8.4l-2.3-1.6v-1.8Z"
        fill="#fff"
      />
    </svg>
  );
}

function MeetMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M1.5 7.4A2.9 2.9 0 0 1 4.4 4.5H11v15H4.4a2.9 2.9 0 0 1-2.9-2.9V7.4Z" fill="#00832D" />
      <path d="M11 4.5h4.4v5.6L11 7.2V4.5Z" fill="#FFBA00" />
      <path d="M11 19.5h4.4v-5.6L11 16.8v2.7Z" fill="#00AC47" />
      <path d="M11 7.2 15.4 10v4l-4.4 2.8V7.2Z" fill="#0066DA" />
      <path
        d="M15.4 9.6 20.6 5.9c.6-.4 1.4 0 1.4.8v10.6c0 .8-.8 1.2-1.4.8l-5.2-3.7V9.6Z"
        fill="#E94235"
      />
    </svg>
  );
}

function TeamsMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="6.5" width="11" height="11" rx="2" fill="#5059C9" />
      <path d="M5.4 9.4h6.2v1.5H9.5v5.1H7.4v-5.1H5.4V9.4Z" fill="#fff" />
      <circle cx="17.6" cy="7.6" r="2.3" fill="#7B83EB" />
      <path
        d="M15.1 11.1h5c.5 0 .9.4.9.9v3.2a2.9 2.9 0 0 1-5.9 0v-4.1Z"
        fill="#7B83EB"
      />
    </svg>
  );
}

function CallMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none">
      <rect
        x="3.2"
        y="6.4"
        width="12.4"
        height="11.2"
        rx="2.4"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M16.4 11 20 8.6v6.8L16.4 13v-2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The mark and display name for a detected app, or the neutral pair when the
 *  detector has not settled on one yet. */
export function callVisual(app: string | null, size = 20) {
  switch (app) {
    case "zoom":
    case "zoom-web":
      return { icon: <ZoomMark size={size} />, name: "Zoom" };
    case "google-meet":
      return { icon: <MeetMark size={size} />, name: "Google Meet" };
    case "teams":
    case "teams-web":
      return { icon: <TeamsMark size={size} />, name: "Microsoft Teams" };
    default:
      return { icon: <CallMark size={size} />, name: null };
  }
}
