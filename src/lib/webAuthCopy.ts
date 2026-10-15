/** Fresh copy for the browser-based Google sign-up flow - not ported from
 * anywhere, written to match the existing Buddy-persona voice in copy.ts. */

export const webAuthCopy = {
  opening: "Opening your browser...",
  waiting: "Finish signing in over there. This picks up on its own once you're done.",
  cancel: "Cancel",
  expired: "That link timed out. Want to try again?",
  accountExistsDifferentCredential:
    "That Google account could not be linked. Try another Google account.",
  cancelled: "Looks like that got closed before finishing. Want to try again?",
  popupBlocked: "Your browser blocked the sign-in window. Check your popup blocker and try again.",
  otherFailure: "Something went sideways. Give it another try.",
  network: "Couldn't reach Aura. Check your connection and try again.",
  timeout: "That took too long. Check your connection and try again.",
  tryAgain: "Try again",
  matchCodeLabel: "Your code",
  matchCodeHint: "When your browser asks for it, type this code there.",
  matchCodeMismatch:
    "The code typed in the browser didn't match this one, so the sign-in was stopped. Start again and type the code shown here.",
} as const;

/** The match code as people read it: "K7Q4MP" -> "K7Q-4MP". */
export function formatMatchCode(code: string): string {
  const clean = code.trim().toUpperCase();
  return clean.length === 6 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
}
