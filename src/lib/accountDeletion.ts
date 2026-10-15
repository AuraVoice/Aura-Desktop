import { invoke } from "@tauri-apps/api/core";
import { authFetchWithTimeout } from "./api";
import { logError } from "./log";

/**
 * Delete account, in the order that can never leave a deleted account still
 * being billed or a deleted account's data on this computer:
 *
 *   1. DELETE /account. juno-backend cancels a web (Dodo) plan FIRST and deletes
 *      nothing if that fails, then removes audio, data and the sign-in.
 *   2. purge_local_account_data (security.rs): this account's rows and files in
 *      every local store. The uid is the native session's, never sent from here.
 *   3. The caller signs out through signOutSession, the one sign-out path.
 *
 * Each failure keeps its cause so the page shows copy for it, never one generic
 * line, and "try again" only where a retry can help.
 */

export type DeleteAccountFailure =
  /** The backend could not read the plan, so it deleted nothing. Retry helps. */
  | "entitlement_unavailable"
  /** The web plan could not be cancelled, so nothing was deleted. Retry helps. */
  | "subscription_cancel_failed"
  /** Deletion started but did not finish. Retrying completes it. */
  | "deletion_failed"
  /** No answer from the backend; the account may or may not be deleted yet. */
  | "unreachable";

export class DeleteAccountError extends Error {
  constructor(readonly reason: DeleteAccountFailure) {
    super(`account deletion failed: ${reason}`);
    this.name = "DeleteAccountError";
  }
}

export interface DeleteAccountResult {
  /** An App Store plan keeps billing until the user cancels it in the App Store. */
  appleSubscriptionActive: boolean;
  /** Local stores that could not be cleared, so the page can say so. */
  localFailures: string[];
}

// The backend deletes a whole account's documents and audio in this one request.
const DELETE_TIMEOUT_MS = 120_000;

const KNOWN_FAILURES: readonly string[] = [
  "entitlement_unavailable",
  "subscription_cancel_failed",
  "deletion_failed",
];

interface PurgeReport {
  purged: string[];
  failed: string[];
}

export async function deleteAccount(): Promise<DeleteAccountResult> {
  let response: Response;
  try {
    response = await authFetchWithTimeout("/account", { method: "DELETE" }, DELETE_TIMEOUT_MS);
  } catch (err) {
    logError("deleteAccount: request", err);
    throw new DeleteAccountError("unreachable");
  }
  const body = (await response.json().catch(() => null)) as
    | { ok?: unknown; reason?: unknown; apple_subscription_active?: unknown }
    | null;
  if (!response.ok || body?.ok !== true) {
    const reason = typeof body?.reason === "string" && KNOWN_FAILURES.includes(body.reason)
      ? (body.reason as DeleteAccountFailure)
      : "deletion_failed";
    throw new DeleteAccountError(reason);
  }

  let localFailures: string[] = [];
  try {
    const report = await invoke<PurgeReport>("purge_local_account_data");
    localFailures = report.failed;
  } catch (err) {
    // Tauri rejects with the bare Rust string, never an Error.
    logError("deleteAccount: local purge", typeof err === "string" ? new Error(err) : err);
    localFailures = ["all"];
  }
  return { appleSubscriptionActive: body.apple_subscription_active === true, localFailures };
}
