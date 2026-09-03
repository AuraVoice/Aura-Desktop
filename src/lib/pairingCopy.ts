import { deviceNoun } from "./platformKeys";
/** Direct port of pairing_service.dart's error copy - verbatim. */

export const pairingErrorCopy = {
  badLength: "That code looks off. It should be 8 letters and numbers.",
  invalidOrExpired: "That code didn't match or has expired. Grab a fresh one on your phone.",
  otherFailure: `Couldn't link this ${deviceNoun()}. Give it another try in a sec?`,
  timeout: "Linking timed out. Check your connection and try again.",
  network: "Couldn't reach Aura. Check your connection and try again.",
  signInFailed:
    "Got the code, but sign-in tripped. Check your PC's date and time are right, then try again.",
} as const;

export const pairingCodeLength = 8;
