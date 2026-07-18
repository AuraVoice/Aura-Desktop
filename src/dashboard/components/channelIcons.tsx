import { Sparkles } from "lucide-react";
import type { DraftChannel } from "../../lib/draft";

/** Icon that takes a `size` (and optional className), the shape shared by both
 * lucide icons and the inline brand SVGs below. */
export type IconComponent = React.ComponentType<{ size?: number; className?: string }>;

/** Multicolor Gmail envelope. lucide has no brand logos, so this is an inline
 * SVG; it carries its own fills and ignores the muted badge text color. */
export function GmailIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 52 40" className={className} aria-hidden="true">
      <path fill="#4285f4" d="M3.5 40h9V22L0 12.7v23.8C0 38.4 1.6 40 3.5 40z" />
      <path fill="#34a853" d="M39.5 40h9c1.9 0 3.5-1.6 3.5-3.5V12.7L39.5 22z" />
      <path fill="#fbbc04" d="M39.5 3.5V22L52 12.7V5.7c0-4.6-5.3-7.3-9-4.5z" />
      <path fill="#ea4335" d="M12.5 22V3.5L26 13.6 39.5 3.5V22L26 32z" />
      <path fill="#c5221f" d="M0 5.7v7l12.5 9.3V3.5L9 1.2C5.3-1.6 0 1.1 0 5.7z" />
    </svg>
  );
}

/** LinkedIn brand mark. */
export function LinkedInIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path
        fill="#0a66c2"
        d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.45v6.29zM5.34 7.43a2.06 2.06 0 1 1 0-4.12 2.06 2.06 0 0 1 0 4.12zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.56C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z"
      />
    </svg>
  );
}

/** Channel -> icon + human label. cold_dm maps to LinkedIn since cold DMs in
 * this product are LinkedIn-oriented; snippet (AI-generated prompts, commands,
 * notes) uses a sparkle rather than an obvious doc/code glyph. */
export function channelVisual(channel: DraftChannel): { Icon: IconComponent; label: string } {
  switch (channel) {
    case "email_reply":
      return { Icon: GmailIcon, label: "Email reply" };
    case "cold_dm":
      return { Icon: LinkedInIcon, label: "Cold DM" };
    case "snippet":
      return { Icon: Sparkles, label: "Snippet" };
    default:
      return { Icon: Sparkles, label: channel };
  }
}
