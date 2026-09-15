type BrandIconProps = {
  size?: number;
  className?: string;
};

export function GoogleCalendarBrandIcon({
  size = 26,
  className,
}: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <rect x="13" y="13" width="22" height="22" fill="#fff" />
      <polygon
        fill="#1e88e5"
        points="25.68,20.92 26.688,22.36 28.272,21.208 28.272,29.56 30,29.56 30,18.616 28.56,18.616"
      />
      <path
        fill="#1e88e5"
        d="M22.943,23.745c.625-.574,1.013-1.37,1.013-2.249 0-1.747-1.533-3.168-3.417-3.168-1.602,0-2.972,1.009-3.33,2.453l1.657.421c.165-.664.868-1.146,1.673-1.146.942,0,1.709.646,1.709,1.44s-.767,1.44-1.709,1.44h-.997v1.728h.997c1.081,0,1.993.751,1.993,1.64 0,.904-.866,1.64-1.931,1.64-.962,0-1.784-.61-1.914-1.418l-1.708.278c.262,1.63,1.799,2.868,3.622,2.868 2.023,0,3.669-1.523,3.669-3.396 0-.791-1.215-2.06-3.023-2.531z"
      />
      <polygon fill="#fbc02d" points="34,42 14,42 13,38 14,34 34,34 35,38" />
      <polygon fill="#4caf50" points="38,35 42,34 42,14 38,13 34,14 34,34" />
      <polygon fill="#e53935" points="34,34 34,42 42,34" />
      <path
        fill="#1565c0"
        d="M9.045,6C7.408,6,6,7.408,6,9.045V34l4,1 4-1V14h20l1-4-1-4H9.045z"
      />
    </svg>
  );
}

export function GmailBrandIcon({ size = 26, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <path fill="#4caf50" d="M45,16.2l-5,2.75-5,4.75L35,40h7c1.657,0,3-1.343,3-3V16.2z" />
      <path fill="#1e88e5" d="M3,16.2l3.614,1.71L13,23.7V40H6c-1.657,0-3-1.343-3-3V16.2z" />
      <polygon
        fill="#e53935"
        points="35,11.2 24,19.45 13,11.2 12,17 13,23.7 24,31.95 35,23.7 36,17"
      />
      <path
        fill="#c62828"
        d="M3,12.298V16.2l10,7.5V11.2L9.876,8.859C9.132,8.301,8.228,8,7.298,8 4.924,8,3,9.924,3,12.298z"
      />
      <path
        fill="#fbc02d"
        d="M45,12.298V16.2l-10,7.5V11.2l3.124-2.341C38.868,8.301,39.772,8,40.702,8 43.076,8,45,9.924,45,12.298z"
      />
    </svg>
  );
}

export function SlackBrandIcon({ size = 26, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <path fill="#33d375" d="M33,8a4,4,0,0,0-8,0v11a4,4,0,0,0,8,0z" />
      <path fill="#33d375" d="M43,19a4,4,0,0,1-4,4h-4v-4a4,4,0,0,1,8,0z" />
      <path fill="#40c4ff" d="M8,14a4,4,0,0,0,0,8h11a4,4,0,0,0,0-8z" />
      <path fill="#40c4ff" d="M19,4a4,4,0,0,1,4,4v4h-4a4,4,0,0,1,0-8z" />
      <path fill="#e91e63" d="M15,40a4,4,0,0,0,8,0V29a4,4,0,0,0-8,0z" />
      <path fill="#e91e63" d="M5,29a4,4,0,0,1,4-4h4v4a4,4,0,0,1-8,0z" />
      <path fill="#ffc107" d="M40,33a4,4,0,0,0,0-8H29a4,4,0,0,0,0,8z" />
      <path fill="#ffc107" d="M29,44a4,4,0,0,1-4-4v-4h4a4,4,0,0,1,0,8z" />
    </svg>
  );
}

export function GitHubBrandIcon({ size = 24, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="currentColor"
        d="M12 1.5a10.5 10.5 0 0 0-3.32 20.46c.53.1.72-.23.72-.5v-1.86c-2.92.63-3.54-1.24-3.54-1.24-.48-1.22-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.06.07 1.61 1.08 1.61 1.08.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.66-1.4-2.33-.27-4.78-1.17-4.78-5.19 0-1.15.41-2.08 1.08-2.82-.1-.26-.47-1.33.1-2.78 0 0 .88-.28 2.89 1.08a10 10 0 0 1 5.26 0c2.01-1.36 2.89-1.08 2.89-1.08.57 1.45.21 2.52.1 2.78.67.74 1.08 1.67 1.08 2.82 0 4.03-2.46 4.92-4.8 5.18.38.33.71.97.71 1.96v2.9c0 .28.19.61.73.5A10.5 10.5 0 0 0 12 1.5Z"
      />
    </svg>
  );
}

export function LinkedInBrandIcon({ size = 24, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <rect x="2" y="2" width="20" height="20" rx="4" fill="#0a66c2" />
      <path
        fill="#fff"
        d="M7.1 9.6h2.4V17H7.1V9.6Zm1.2-3.7a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8Zm2.9 3.7h2.3v1c.32-.6 1.1-1.22 2.27-1.22 2.43 0 2.88 1.6 2.88 3.68V17h-2.4v-3.54c0-.85-.02-1.94-1.18-1.94-1.18 0-1.36.92-1.36 1.88V17h-2.4V9.6Z"
      />
    </svg>
  );
}

export function XBrandIcon({ size = 22, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <path
        fill="currentColor"
        d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.77L17.75 3Zm-1.08 16.18h1.7L7.4 4.73H5.58l11.09 14.45Z"
      />
    </svg>
  );
}

export function GoogleClassroomBrandIcon({ size = 24, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden className={className}>
      <rect x="2" y="4" width="20" height="16" rx="2" fill="#0f9d58" />
      <rect x="4" y="6" width="16" height="12" rx="1" fill="#57bb8a" />
      <circle cx="12" cy="10.5" r="1.8" fill="#fff" />
      <path fill="#fff" d="M8.8 15.5c.4-1.6 1.7-2.5 3.2-2.5s2.8.9 3.2 2.5H8.8Z" />
      <rect x="14" y="18" width="5" height="1.4" rx=".7" fill="#fff" />
    </svg>
  );
}

export function NotionBrandIcon({ size = 24, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7.2 7.1v9.8M7.2 7.1l9.6 9.8M16.8 7.1v9.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
