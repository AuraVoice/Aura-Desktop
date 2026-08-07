// Proves the updater private key in CI is the one this build's clients will
// trust, by comparing minisign key IDs.
//
// The existing "Validate updater signing key" check only proves the private key
// parses and the password is right. It cannot catch a private key that belongs
// to a DIFFERENT keypair than plugins.updater.pubkey in tauri.conf.json. That
// combination builds, publishes and verifies perfectly in CI, then fails on
// every user's machine: the pubkey is compiled into the shipped app, so it is
// the already-installed copy that decides whether a new signature is
// acceptable. The key has already been rotated twice in this repo, so this is a
// live failure mode, not a hypothetical one.
//
// Both a minisign public key and a minisign signature carry the same 8-byte key
// ID at bytes 2..10 of their decoded line 2. Tauri wraps each whole minisign
// file in another layer of base64 (that is the form stored in tauri.conf.json
// and written to .sig), so each side is decoded twice.
//
// Bytes 0..2 are the algorithm and are deliberately NOT compared: a public key
// reports "Ed" while a signature over a prehashed file reports "ED", so a
// whole-prefix comparison would fail on a perfectly matched pair.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const configPath = path.join(repoRoot, "src-tauri", "tauri.conf.json");

/// Unwraps Tauri's outer base64, takes the minisign payload line, and returns
/// the key ID as hex. Works for a public key and a signature alike.
function keyId(wrapped, label) {
  let minisignFile;
  try {
    minisignFile = Buffer.from(wrapped.trim(), "base64").toString("utf8");
  } catch {
    throw new Error(`${label} is not valid base64`);
  }
  const payload = minisignFile.split(/\r?\n/)[1];
  if (!payload) {
    throw new Error(`${label} has no minisign payload line`);
  }
  const raw = Buffer.from(payload, "base64");
  // 2 algo + 8 key id + 32 key (public) or + 64 signature.
  if (raw.length !== 42 && raw.length !== 74) {
    throw new Error(
      `${label} decoded to ${raw.length} bytes, expected 42 (public key) or 74 (signature)`,
    );
  }
  return raw.subarray(2, 10).toString("hex");
}

async function main() {
  const signaturePath = process.argv[2];
  if (!signaturePath) {
    throw new Error("usage: verify-updater-key.mjs <path to a .sig>");
  }

  const config = JSON.parse(await readFile(configPath, "utf8"));
  const pubkey = config.plugins?.updater?.pubkey;
  if (!pubkey) {
    throw new Error("tauri.conf.json declares no plugins.updater.pubkey");
  }

  const expected = keyId(pubkey, "tauri.conf.json pubkey");
  const actual = keyId(await readFile(signaturePath, "utf8"), signaturePath);

  if (expected !== actual) {
    throw new Error(
      `TAURI_SIGNING_PRIVATE_KEY belongs to key ${actual}, but this build ships pubkey ${expected}. ` +
        `Releasing this would produce updates that every client rejects. Point the secret at the ` +
        `keypair matching tauri.conf.json, or update tauri.conf.json to the pubkey for the secret.`,
    );
  }

  console.log(`Updater signing key matches the shipped pubkey (key id ${expected}).`);
}

main().catch((error) => {
  console.error(`updater key check failed: ${error.message}`);
  process.exit(1);
});
