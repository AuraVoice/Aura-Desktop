import { invoke } from "@tauri-apps/api/core";
import { signOut } from "firebase/auth";
import { auth } from "./firebase";
import { clearDashboardCache } from "./dashboardCache";
import { flushInterviewWorkspaceWrites } from "./interviewWorkspace";
import { clearInterviewSessions } from "./interviewSessions";
import { logError } from "./log";
import { revokeSavedImages } from "./savedImageCache";

let activeSignOut: Promise<void> | null = null;

async function restoreNativeSession(): Promise<void> {
  const currentUser = auth.currentUser;
  await Promise.allSettled([
    invoke("set_auth_state", {
      signedIn: currentUser !== null,
      uid: currentUser?.uid ?? null,
    }),
    invoke("set_session_cached", { hasSession: currentUser !== null }),
  ]);
}

async function performSignOut(): Promise<void> {
  const departingUid = auth.currentUser?.uid ?? null;
  try {
    // Lock native commands first, then remove the short-lived transcription
    // credential before Firebase clears its persisted refresh and ID tokens.
    // This ordering means the signed-out UI is never shown while an old
    // credential is still usable by this process.
    await invoke("set_auth_state", { signedIn: false, uid: null });
    await invoke("dictation_clear_credential");

    // Voice credentials only live inside the active webview session. Dismissing
    // the bar emits end-voice-session, which tears down Realtime and LiveKit.
    // The entitlement cache is account-scoped state rather than a credential,
    // but clearing it here prevents it from surviving an account change.
    const cleanupResults = await Promise.allSettled([
      invoke("dismiss_bar"),
      invoke("clear_entitlement_cache"),
      invoke("set_session_cached", { hasSession: false }),
    ]);
    cleanupResults.forEach((result, index) => {
      if (result.status === "rejected") {
        const operation = ["dismiss_bar", "clear_entitlement_cache", "set_session_cached"][index];
        logError(`signOutSession: ${operation}`, result.reason);
      }
    });

    revokeSavedImages();
    await signOut(auth);
    await flushInterviewWorkspaceWrites();
    await clearDashboardCache(departingUid);
    // Locally stored interview transcripts are per-account. The native session
    // hook already prunes on every transition; this is the explicit React-side
    // drop, matching how the dashboard cache is cleared here.
    if (departingUid) {
      await clearInterviewSessions(departingUid).catch((err) =>
        logError("signOutSession: clearInterviewSessions", err),
      );
    }
  } catch (err) {
    // A failed Firebase sign-out leaves the user authenticated. Restore the
    // native mirror so the signed-in UI and native authorization cannot split.
    await restoreNativeSession();
    throw err;
  }
}

/** One sign-out path for dashboard, tray, and hotkey requests. Concurrent
 * requests share the same operation so token cleanup cannot race itself. */
export function signOutSession(): Promise<void> {
  if (activeSignOut) return activeSignOut;
  activeSignOut = performSignOut().finally(() => {
    activeSignOut = null;
  });
  return activeSignOut;
}
