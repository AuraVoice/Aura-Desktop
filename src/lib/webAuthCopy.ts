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
} as const;
