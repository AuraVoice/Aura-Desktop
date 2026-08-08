import { initializeApp } from "firebase/app";
import { indexedDBLocalPersistence, initializeAuth } from "firebase/auth";
import { firebaseConfig } from "./firebaseConfig";

const app = initializeApp(firebaseConfig);

// Persistence is configured EXPLICITLY rather than through getAuth()'s
// default chain, so what gets stored where is a documented decision, not an
// SDK default that could drift across versions: the session (including the
// Firebase refresh token) lives in the WebView2 profile's IndexedDB. That
// placement is a known, accepted risk pending sign-off - it survives
// uninstall and is readable by anything running as this Windows user - see
// PRIVACY_AUDIT.md ("Firebase SDK persistence"). Moving it into Windows
// Credential Manager needs a custom Persistence adapter and is tracked
// there as future work.
//
// initializeAuth (vs getAuth) also skips the popup/redirect resolver on
// purpose: Google authentication completes in the system browser and returns
// a custom token, so this webview never uses popup or redirect flows.
//
// Tokens never cross into Rust: the Rust side learns only a boolean+uid via
// set_auth_state (security.rs) and a boolean UI hint via set_session_cached
// (auth_cache.rs).
export const auth = initializeAuth(app, {
  persistence: indexedDBLocalPersistence,
});
