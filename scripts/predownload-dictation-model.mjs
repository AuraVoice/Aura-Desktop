// Build-time fetch for local dictation's on-device speech recognition.
//
// Everything dictation needs at runtime is bundled into the installer, so the
// shipped app never downloads anything and never touches the network to
// transcribe. This script is what puts those files on disk before the bundle
// is built.
//
// Two archives are pulled, both pinned:
//   1. sherpa-onnx's prebuilt Windows x64 CPU shared release. Only the C API
//      and ONNX Runtime CPU DLLs are copied out. The DirectML
//      and CUDA provider DLLs are deliberately not shipped: ONNX Runtime probes
//      the adapter at session creation and can reserve VRAM without a line of
//      our code asking it to.
//   2. the cache-aware 560 ms streaming Nemotron English model. All three
//      transducer graphs are the archive's pinned INT8 files.
//
// SHERPA_VERSION is also the version the FFI struct layout in
// src-tauri/src/dictation/stt.rs was transcribed from. Bumping it means
// re-checking those structs against that release's c-api.h.
//
// Idempotent: it exits once every target file is present AND matches the
// digest recorded when it was installed, so chaining it into `npm run build`
// costs one pass of hashing after the first run and nothing else.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  copyFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHERPA_VERSION = "v1.13.4";
const MODEL_NAME =
  "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const resourcesDir = path.join(repoRoot, "src-tauri", "resources");
const targetDir = path.join(resourcesDir, "dictation");
// A sibling of the target so the swap at the end is a same-volume rename.
const stagingDir = path.join(resourcesDir, ".dictation-staging");
const cacheDir = path.join(repoRoot, "node_modules", ".cache", "dictation");
const MANIFEST_NAME = "installed.json";
const README_NAME = "README.md";
const manifestPath = path.join(targetDir, MANIFEST_NAME);

// The DLLs are copied out under fixed names, so they can be required by name.
// The model archive has one exact INT8 file for each transducer role. Those
// names are recorded in the manifest, which is what the runtime reads.
const REQUIRED_LIBS = [
  "sherpa-onnx-c-api.dll",
  "onnxruntime.dll",
  "onnxruntime_providers_shared.dll",
];
const REQUIRED_ROLES = ["encoder", "decoder", "joiner", "tokens"];
// Bumped whenever the manifest's shape changes, so an install written by an
// older version of this script is reinstalled instead of half-understood.
// Version 2 added per-file digests and the resolved model role names.
const MANIFEST_VERSION = 3;

const LIBS_ARCHIVE = `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared-MD-Release-no-tts-lib.tar.bz2`;
const MODEL_ARCHIVE = `${MODEL_NAME}.tar.bz2`;

// Pinned size and SHA-256 for every archive. These are NATIVE CODE that Aura
// loads into its own process, so presence on disk is not evidence of anything:
// a corrupted cache, an interrupted build, or a replaced upstream asset would
// otherwise be extracted and loaded without a word. Verified before extraction,
// on a fresh download and on a cache hit alike.
//
// To bump a version: change the tag or model name, download the new asset, and
// replace both the size and the digest here. A stale digest fails the build
// loudly rather than silently installing something unexpected.
const ARCHIVES = {
  libs: {
    name: LIBS_ARCHIVE,
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/${LIBS_ARCHIVE}`,
    bytes: 6725033,
    sha256:
      "dec41ab3944985cce39e596cb757732f1b275720d62f117fc5afe10f51c4bf7d",
  },
  model: {
    name: MODEL_ARCHIVE,
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE}`,
    bytes: 463945051,
    sha256:
      "78e2b79fcf7271553a74402a76b771b09ea40117a39566a79f52235b23db6358",
  },
};

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function sha256(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

/// The installed resources are trusted only when ALL of this holds:
///   - the manifest names exactly these pinned archives and this script's
///     manifest version,
///   - it declares every required role and every required DLL,
///   - every file it lists is present at its recorded size AND its recorded
///     SHA-256,
///   - and the directory holds no native file the manifest does not list.
///
/// Sizes alone are not enough. These are native code and model weights loaded
/// straight into Aura's process, and a release machine keeps this directory
/// across many builds: a same-size corrupted DLL, or a leftover encoder from a
/// previous model that the runtime might pick instead, would both pass a name
/// and length check and then ship. Anything short of a full match triggers a
/// clean reinstall rather than a repair, so no partial state survives.
async function alreadyInstalled() {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    return false;
  }
  if (
    manifest.manifestVersion !== MANIFEST_VERSION ||
    manifest.sherpaVersion !== SHERPA_VERSION ||
    manifest.modelName !== MODEL_NAME ||
    manifest.archives?.libs !== ARCHIVES.libs.sha256 ||
    manifest.archives?.model !== ARCHIVES.model.sha256
  ) {
    console.log("dictation: pinned version or digest changed, reinstalling");
    return false;
  }

  const files = manifest.files ?? {};
  const declared = new Set(Object.keys(files));
  const roles = manifest.model ?? {};
  const required = [...REQUIRED_LIBS];
  for (const role of REQUIRED_ROLES) {
    const name = roles[role];
    if (typeof name !== "string" || !name) {
      console.log(`dictation: the manifest declares no ${role}, reinstalling`);
      return false;
    }
    required.push(name);
  }
  for (const name of required) {
    if (!declared.has(name)) {
      console.log(`dictation: ${name} is not in the manifest, reinstalling`);
      return false;
    }
  }

  for (const [name, recorded] of Object.entries(files)) {
    const file = path.join(targetDir, name);
    let info;
    try {
      info = await stat(file);
    } catch {
      console.log(`dictation: ${name} is missing, reinstalling`);
      return false;
    }
    if (!recorded?.sha256 || info.size === 0 || info.size !== recorded.bytes) {
      console.log(`dictation: ${name} has an unexpected size, reinstalling`);
      return false;
    }
    if ((await sha256(file)) !== recorded.sha256) {
      console.log(`dictation: ${name} failed its SHA-256 check, reinstalling`);
      return false;
    }
  }

  // A file the manifest never wrote is either a stale model from an earlier
  // pin or something dropped in by hand. Either way the runtime could resolve
  // it, so the directory is rebuilt rather than trusted.
  let present;
  try {
    present = await readdir(targetDir);
  } catch {
    return false;
  }
  for (const name of present) {
    if (name === MANIFEST_NAME || name === README_NAME || declared.has(name)) {
      continue;
    }
    console.log(`dictation: ${name} is not from this install, reinstalling`);
    return false;
  }
  return true;
}

/// Verifies size first (cheap, catches a truncated download immediately) and
/// then the digest. A failure deletes the file so the next run refetches rather
/// than failing forever on a poisoned cache.
async function verify(file, expected) {
  const info = await stat(file);
  if (info.size !== expected.bytes) {
    await rm(file, { force: true });
    throw new Error(
      `${expected.name} is ${info.size} bytes, expected ${expected.bytes}. The cached copy was discarded, run this again.`,
    );
  }
  const digest = await sha256(file);
  if (digest !== expected.sha256) {
    await rm(file, { force: true });
    throw new Error(
      `${expected.name} failed its SHA-256 check (got ${digest}, expected ${expected.sha256}). The cached copy was discarded. If the upstream asset really did change, update the pin in this script deliberately.`,
    );
  }
}

async function fetchArchive(expected) {
  const destination = path.join(cacheDir, expected.name);
  if (await exists(destination)) {
    console.log(`dictation: verifying cached ${expected.name}`);
    await verify(destination, expected);
    return destination;
  }
  console.log(`dictation: downloading ${expected.url}`);
  const response = await fetch(expected.url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${expected.url}`);
  }
  const partial = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  // Verified under the .partial name, so a failed check can never leave a file
  // at the real path for a later run to treat as a valid cache hit.
  await verify(partial, expected);
  await rename(partial, destination);
  return destination;
}

function extract(archive, into) {
  // bsdtar ships with Windows 10 and later and reads bz2 natively.
  execFileSync("tar", ["-xjf", archive, "-C", into], { stdio: "inherit" });
}

async function main() {
  await mkdir(targetDir, { recursive: true });
  if (await alreadyInstalled()) {
    console.log("dictation: model and runtime already present, nothing to do");
    return;
  }
  await mkdir(cacheDir, { recursive: true });

  const libsArchive = await fetchArchive(ARCHIVES.libs);
  const modelArchive = await fetchArchive(ARCHIVES.model);

  const extractDir = path.join(cacheDir, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  extract(libsArchive, extractDir);
  extract(modelArchive, extractDir);

  // Everything is built in a staging directory that starts empty, and the
  // target is only replaced once the whole set is in place and verified. A
  // reinstall therefore cannot leave a stale model file behind for the runtime
  // to resolve, and an interrupted run leaves the previous good install alone.
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  const readmePath = path.join(targetDir, README_NAME);
  if (await exists(readmePath)) {
    await copyFile(readmePath, path.join(stagingDir, README_NAME));
  }

  const installed = [];
  async function install(from, name) {
    const to = path.join(stagingDir, name);
    await copyFile(from, to);
    const info = await stat(to);
    if (info.size === 0) {
      throw new Error(`${name} was installed empty`);
    }
    installed.push([name, { bytes: info.size, sha256: await sha256(to) }]);
  }

  const libsDir = path.join(
    extractDir,
    `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared-MD-Release-no-tts-lib`,
    "lib",
  );
  for (const name of REQUIRED_LIBS) {
    await install(path.join(libsDir, name), name);
  }

  const modelDir = path.join(extractDir, MODEL_NAME);
  const roles = {
    encoder: "encoder.int8.onnx",
    decoder: "decoder.int8.onnx",
    joiner: "joiner.int8.onnx",
    tokens: "tokens.txt",
  };
  for (const role of REQUIRED_ROLES) {
    await install(path.join(modelDir, roles[role]), roles[role]);
  }

  await writeFile(
    path.join(stagingDir, MANIFEST_NAME),
    `${JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        sherpaVersion: SHERPA_VERSION,
        modelName: MODEL_NAME,
        archives: {
          libs: ARCHIVES.libs.sha256,
          model: ARCHIVES.model.sha256,
        },
        // The runtime reads these exact names rather than scanning the
        // directory for a prefix match, so which encoder/joiner precision was
        // installed is decided here, once, and never re-guessed on the user's
        // machine.
        model: roles,
        streaming: {
          chunkMs: 560,
          cacheAware: true,
          contextualBiasing: false,
        },
        files: Object.fromEntries(installed),
      },
      null,
      2,
    )}\n`,
  );

  // Swap last. rename() onto an existing directory fails on Windows, so the
  // old one is removed first; the window between the two is the only moment
  // the target is incomplete, and a crash inside it leaves the staging copy on
  // disk for the next run to rebuild from scratch.
  await rm(targetDir, { recursive: true, force: true });
  await rename(stagingDir, targetDir);
  await rm(extractDir, { recursive: true, force: true });
  console.log(`dictation: installed the runtime and model into ${targetDir}`);
}

main().catch((error) => {
  console.error(`dictation: predownload failed: ${error.message}`);
  process.exit(1);
});
