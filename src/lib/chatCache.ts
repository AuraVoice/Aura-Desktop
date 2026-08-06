import { invoke } from "@tauri-apps/api/core";
import { logError } from "./log";

/**
 * Local read cache for the desktop chat transcript, backed by encrypted SQLite
 * in Rust (`src-tauri/src/chat_cache.rs` - message text is AES-256-GCM under the
 * same DPAPI-wrapped key the meeting pipeline uses).
 *
 * Two rules define this module:
 *
 * 1. It is NEVER a source of truth. Firestore, reached through /desktop/chat/*,
 *    owns the transcript. This only makes the overlay paint instantly on open
 *    and keeps a just-sent message visible across a crash.
 * 2. It NEVER throws. Every function swallows into logError and returns a
 *    neutral value, so a corrupt, locked, or unwritable database degrades to
 *    "no cache" instead of blocking a send or surfacing a storage error the
 *    user can do nothing about.
 *
 * Every call carries the account's uid; Rust filters on it and prunes other
 * accounts' rows at the native session boundary.
 */

export interface CachedChatMessage {
  message_id: string;
  client_message_id: string;
  conversation_id: string;
  role: "user" | "assistant";
  text: string;
  status: string;
  seq: number;
  created_at_ms: number;
  has_attachments: boolean;
}

export interface CachedChatConversation {
  conversation_id: string;
  messages: CachedChatMessage[];
}

/** Replaces one conversation's cached messages wholesale. Not an upsert: a retry
 * re-keys its bubble to a fresh client_message_id, and an upsert would leave the
 * old row behind to reappear as a duplicate on the next cache-first paint.
 * Fire-and-forget by design - callers do not await it on the send path, so a
 * slow disk can never delay a request. */
export async function replaceCachedConversation(
  uid: string,
  conversationId: string,
  messages: CachedChatMessage[],
): Promise<void> {
  if (!uid || !conversationId) return;
  try {
    await invoke("chat_cache_replace", { uid, conversationId, messages });
  } catch (err) {
    logError("chatCache: replace", err);
  }
}

/** Loads a conversation, or the account's most recent one when no id is given.
 * Returns null on any failure, which the caller treats as an empty cache. */
export async function loadCachedConversation(
  uid: string,
  conversationId: string | null,
  limit = 200,
): Promise<CachedChatConversation | null> {
  if (!uid) return null;
  try {
    return await invoke<CachedChatConversation | null>("chat_cache_load", {
      uid,
      conversationId,
      limit,
    });
  } catch (err) {
    logError("chatCache: load", err);
    return null;
  }
}

/** Drops one account's cached chat, or every account's when uid is null. The
 * native session boundary does this too; neither path is load-bearing alone. */
export async function clearCachedChat(uid: string | null): Promise<void> {
  try {
    await invoke("chat_cache_clear", { uid });
  } catch (err) {
    logError("chatCache: clear", err);
  }
}
