/** Small inline icon set for the bar/pill - no icon font/library dependency needed for this handful of glyphs. */

export function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

export function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z" />
    </svg>
  );
}

/** Blank shades over a hat when off (private, incognito), two small pupils
 * appear inside the same lenses when armed (watching). One silhouette, only
 * the eyes change, since the toggle is really "is Buddy watching or not." */
export function IncognitoOffIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M5 11A7 6 0 0 1 19 11Z" fill="currentColor" />
      <rect x="3" y="10.2" width="18" height="2" rx="1" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.9 12.6H16.1A3.4 3.4 0 0 1 19.5 16V17A3.4 3.4 0 0 1 16.1 20.4H7.9A3.4 3.4 0 0 1 4.5 17V16A3.4 3.4 0 0 1 7.9 12.6Z M6.9 16.3a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0 -3.4 0Z M13.7 16.3a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0 -3.4 0Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function IncognitoOnIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <path d="M5 11A7 6 0 0 1 19 11Z" fill="currentColor" />
      <rect x="3" y="10.2" width="18" height="2" rx="1" fill="currentColor" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.9 12.6H16.1A3.4 3.4 0 0 1 19.5 16V17A3.4 3.4 0 0 1 16.1 20.4H7.9A3.4 3.4 0 0 1 4.5 17V16A3.4 3.4 0 0 1 7.9 12.6Z M6.9 16.3a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0 -3.4 0Z M13.7 16.3a1.7 1.7 0 1 0 3.4 0 1.7 1.7 0 1 0 -3.4 0Z"
        fill="currentColor"
      />
      <circle cx="8.6" cy="16.3" r="0.85" fill="currentColor" />
      <circle cx="15.4" cy="16.3" r="0.85" fill="currentColor" />
    </svg>
  );
}

/** Seven bar level meter. Same glyph for idle and live, VoiceBar.css animates
 * the bars and recolors them while a call is live instead of swapping to a
 * separate "end call" pictogram. */
export function WaveformIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="0.4" y="8" width="2.2" height="8" rx="1.1" />
      <rect x="3.9" y="4.5" width="2.2" height="15" rx="1.1" />
      <rect x="7.4" y="6.5" width="2.2" height="11" rx="1.1" />
      <rect x="10.9" y="2" width="2.2" height="20" rx="1.1" />
      <rect x="14.4" y="6.5" width="2.2" height="11" rx="1.1" />
      <rect x="17.9" y="4.5" width="2.2" height="15" rx="1.1" />
      <rect x="21.4" y="8" width="2.2" height="8" rx="1.1" />
    </svg>
  );
}

/** Head and shoulders mark for the minimize button, matching what it actually
 * does: collapses the bar to the floating avatar on screen while the call
 * keeps going. */
export function AvatarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="8" r="4.2" />
      <path d="M4 20A8 7 0 0 1 20 20Z" />
    </svg>
  );
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M9 7V4.8c0-.44.36-.8.8-.8h4.4c.44 0 .8.36.8.8V7" />
      <path d="M6 7l1 13.2c.03.44.4.8.85.8h8.3c.44 0 .82-.36.85-.8L18 7" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
      <path d="M5.5 15H4.8A1.8 1.8 0 0 1 3 13.2V4.8A1.8 1.8 0 0 1 4.8 3h8.4A1.8 1.8 0 0 1 15 4.8v.7" />
    </svg>
  );
}

/** Copy button's brief "it worked" state - pairs with CopyIcon. */
export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 12.5l5 5.5 10-12" />
    </svg>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function FeedbackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 6.5l8 6.5 8-6.5" />
    </svg>
  );
}

/** 2x2 grid of rounded squares - same shape as Aura-Web's own dashboard
 * sidebar "Overview" icon, so the tray/bar entry point and the page it
 * opens visually agree on what "dashboard" means across both apps. */
export function DashboardIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </svg>
  );
}

/** Up arrow lifting out of a tray - "a new version is ready to come up". */
export function UpdateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 14.5V4" />
      <path d="M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 14.8v3.4c0 1 .8 1.8 1.8 1.8h12.4c1 0 1.8-.8 1.8-1.8v-3.4" />
    </svg>
  );
}

export function SignOutIcon() {
  return (
    <svg viewBox="0 0 24 24">
      <circle cx="7" cy="4.5" r="2" fill="currentColor" />
      <path d="M7.2 7.2L9.8 12.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M9.8 12.5L11.8 15L11.3 19" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M9.8 12.5L7 15.5L4.2 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M7.5 8L11.8 9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7 7.8L4.3 8.8L2.5 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M14 2.5H20.5V21.5H14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.5 6H18M15 3.3L18 6L15 8.7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
