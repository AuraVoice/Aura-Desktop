// Shapes a chat email draft for the overlay's email card: the signature it ends
// with and the Gmail compose link it opens. The backend's email body stops
// before any sign-off (draft_writing with_subject), so the signature here is
// the only one the email ever carries.

/** The signature to append. The user's own from Settings wins; otherwise a
 * plain "Best," over their first name, or just "Best," with no name known. */
export function resolveEmailSignature(saved: string, displayName: string | null | undefined): string {
  const own = saved.trim();
  if (own) return own;
  const firstName = displayName?.trim().split(/\s+/)[0] ?? "";
  return firstName ? `Best,\n${firstName}` : "Best,";
}

/** Body and signature as one paste-ready block. */
export function emailWithSignature(body: string, signature: string): string {
  const trimmedBody = body.trimEnd();
  return signature ? `${trimmedBody}\n\n${signature}` : trimmedBody;
}

/** Gmail's compose window, prefilled. Opens a new message: a URL cannot attach
 * to an existing thread, which is why the card also offers Copy. `to` is a
 * meeting follow-up's invitees; a chat email leaves it for the user to fill. */
export function gmailComposeUrl(subject: string, body: string, to: string[] = []): string {
  // encodeURIComponent rather than URLSearchParams: the latter writes spaces
  // as "+", which Gmail can show literally in the subject.
  const params = [`view=cm`, `fs=1`];
  if (to.length > 0) params.push(`to=${encodeURIComponent(to.join(","))}`);
  if (subject) params.push(`su=${encodeURIComponent(subject)}`);
  params.push(`body=${encodeURIComponent(body)}`);
  return `https://mail.google.com/mail/?${params.join("&")}`;
}
