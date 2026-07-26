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

export function NotionBrandIcon({ size = 24, className }: BrandIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden className={className}>
      <rect x="3" y="3" width="18" height="18" rx="2.5" stroke="#111827" strokeWidth="1.8" />
      <path d="M7.2 7.1v9.8M7.2 7.1l9.6 9.8M16.8 7.1v9.8" stroke="#111827" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
