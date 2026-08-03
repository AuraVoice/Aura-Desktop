// Build-time fetch for local dictation's on-device speech recognition.
//
// Everything dictation needs at runtime is bundled into the installer, so the
// shipped app never downloads anything and never touches the network to
// transcribe. This script is what puts those files on disk before the bundle
// is built.
//
// Two archives are pulled, both pinned:
//   1. sherpa-onnx's prebuilt Windows x64 SHARED release. Only
//      sherpa-onnx-c-api.dll and onnxruntime.dll are copied out. The DirectML
//      and CUDA provider DLLs are deliberately not shipped: ONNX Runtime probes
//      the adapter at session creation and can reserve VRAM without a line of
//      our code asking it to.
//   2. the streaming Zipformer 20M English model. The INT8 encoder and joiner
//      are preferred where both precisions are published.
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

const SHERPA_VERSION = "v1.10.46";
const MODEL_NAME = "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const resourcesDir = path.join(repoRoot, "src-tauri", "resources");
const targetDir = path.join(resourcesDir, "dictation");
// A sibling of the target so the swap at the end is a same-volume rename.
const stagingDir = path.join(resourcesDir, ".dictation-staging");
const cacheDir = path.join(repoRoot, "node_modules", ".cache", "dictation");
const MANIFEST_NAME = "installed.json";
// Committed, and the only reason the Tauri resource glob matches in a fresh
// clone that has not run this script yet. It is neither downloaded nor recorded
// in the manifest, so it has to be excused from the unknown-file check below AND
// carried across the staging swap, which replaces this directory wholesale.
const README_NAME = "README.md";
const manifestPath = path.join(targetDir, MANIFEST_NAME);

// The DLLs are copied out under fixed names, so they can be required by name.
// The four model roles are resolved from the archive (the epoch/avg numbers in
// those file names move between releases) and then recorded in the manifest,
// which is what the runtime reads. bpe.vocab is the only optional file.
const REQUIRED_LIBS = ["sherpa-onnx-c-api.dll", "onnxruntime.dll"];
const REQUIRED_ROLES = ["encoder", "decoder", "joiner", "tokens"];
// Bumped whenever the manifest's shape changes, so an install written by an
// older version of this script is reinstalled instead of half-understood.
// Version 2 added per-file digests and the resolved model role names.
// Version 3 added the punctuation model.
const MANIFEST_VERSION = 3;

// Punctuation and true casing. The ASR model is LibriSpeech-trained, so its
// token table is ENTIRELY uppercase with no punctuation and the decoder cannot
// emit anything else; the first hardware run inserted "HOW ARE YOU I AM FINE"
// and that is the model working correctly. This second model is what turns that
// into "How are you? I am fine."
//
// Installed under distinct names on purpose. The archive's own files are
// `model.int8.onnx` and `bpe.vocab`, and everything lands in ONE flat resource
// directory: `bpe.vocab` would collide with the ASR model's hotword vocabulary
// the moment an ASR archive ships one, and silently feeding the punctuator's
// vocabulary to the recognizer would corrupt biasing rather than fail.
const PUNCT_NAME = "sherpa-onnx-online-punct-en-2024-08-06";
const PUNCT_MODEL_FILE = "punct.int8.onnx";
const PUNCT_VOCAB_FILE = "punct-bpe.vocab";

const LIBS_ARCHIVE = `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared.tar.bz2`;
const MODEL_ARCHIVE = `${MODEL_NAME}.tar.bz2`;
const PUNCT_ARCHIVE = `${PUNCT_NAME}.tar.bz2`;

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
    bytes: 21109135,
    sha256:
      "52bc6d41b0050a4ad160a767319fd4dad0f87806bb6d4c2a4721c168abe65be6",
  },
  model: {
    name: MODEL_ARCHIVE,
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE}`,
    bytes: 127887156,
    sha256:
      "9c559283e8498d3fe95913c79ca1cb454bb26281ac2b102b41306c7d752765d9",
  },
  punct: {
    name: PUNCT_ARCHIVE,
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/${PUNCT_ARCHIVE}`,
    bytes: 30667839,
    sha256:
      "9f5e5a72c7d2829635bd074fce92b6bbd5b78da8a52e7ad8ed1be933f366b99d",
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
    manifest.archives?.model !== ARCHIVES.model.sha256 ||
    manifest.archives?.punct !== ARCHIVES.punct.sha256
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
  if (roles.bpeVocab) {
    required.push(roles.bpeVocab);
  }
  const punctuation = manifest.punctuation ?? {};
  if (!punctuation.model || !punctuation.bpeVocab) {
    console.log("dictation: the manifest declares no punctuation model, reinstalling");
    return false;
  }
  required.push(punctuation.model, punctuation.bpeVocab);
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

/// Picks one file out of an extracted directory by name prefix, preferring the
/// INT8 build when both precisions were published.
async function pickModelFile(dir, prefix, preferInt8) {
  const entries = await readdir(dir);
  const matches = entries.filter(
    (name) => name.startsWith(prefix) && name.endsWith(".onnx"),
  );
  if (matches.length === 0) {
    throw new Error(`the model archive has no ${prefix} file`);
  }
  if (preferInt8) {
    const int8 = matches.find((name) => name.includes(".int8."));
    if (int8) {
      return int8;
    }
  }
  const plain = matches.find((name) => !name.includes(".int8."));
  return plain ?? matches[0];
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
  const punctArchive = await fetchArchive(ARCHIVES.punct);

  const extractDir = path.join(cacheDir, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  extract(libsArchive, extractDir);
  extract(modelArchive, extractDir);
  extract(punctArchive, extractDir);

  // Everything is built in a staging directory that starts empty, and the
  // target is only replaced once the whole set is in place and verified. A
  // reinstall therefore cannot leave a stale model file behind for the runtime
  // to resolve, and an interrupted run leaves the previous good install alone.
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

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
    `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared`,
    "lib",
  );
  for (const name of REQUIRED_LIBS) {
    await install(path.join(libsDir, name), name);
  }

  const modelDir = path.join(extractDir, MODEL_NAME);
  const roles = {
    encoder: await pickModelFile(modelDir, "encoder", true),
    decoder: await pickModelFile(modelDir, "decoder", false),
    joiner: await pickModelFile(modelDir, "joiner", true),
    tokens: "tokens.txt",
  };
  for (const role of REQUIRED_ROLES) {
    await install(path.join(modelDir, roles[role]), roles[role]);
  }

  // bpe.vocab is what sherpa-onnx needs to tokenize hotwords for a BPE English
  // model. The pinned archive does NOT ship one, so tier 0 contextual biasing
  // turns itself off and only tier 1 corrections apply. Plain dictation is
  // unaffected. dictation/stt.rs logs this once at startup and reports it
  // through dictation_status.biasingAvailable.
  const bpeVocab = path.join(modelDir, "bpe.vocab");
  if (await exists(bpeVocab)) {
    await install(bpeVocab, "bpe.vocab");
    roles.bpeVocab = "bpe.vocab";
  } else {
    console.warn(
      "dictation: bpe.vocab is not in the model archive, contextual biasing will be off",
    );
  }

  // Only the INT8 punctuation model is installed. The archive also carries a
  // 28MB fp32 `model.onnx`, which would nearly quadruple what this feature adds
  // to the installer for output the user cannot tell apart.
  const punctDir = path.join(extractDir, PUNCT_NAME);
  await install(path.join(punctDir, "model.int8.onnx"), PUNCT_MODEL_FILE);
  await install(path.join(punctDir, "bpe.vocab"), PUNCT_VOCAB_FILE);
  const punctuation = {
    model: PUNCT_MODEL_FILE,
    bpeVocab: PUNCT_VOCAB_FILE,
  };

  await writeFile(
    path.join(stagingDir, MANIFEST_NAME),
    `${JSON.stringify(
      {
        manifestVersion: MANIFEST_VERSION,
        sherpaVersion: SHERPA_VERSION,
        modelName: MODEL_NAME,
        punctName: PUNCT_NAME,
        archives: {
          libs: ARCHIVES.libs.sha256,
          model: ARCHIVES.model.sha256,
          punct: ARCHIVES.punct.sha256,
        },
        punctuation,
        // The runtime reads these exact names rather than scanning the
        // directory for a prefix match, so which encoder/joiner precision was
        // installed is decided here, once, and never re-guessed on the user's
        // machine.
        model: roles,
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
  // Carry the committed README across. Without this the swap deletes the one
  // file in here that is tracked by git, which is exactly the file that keeps
  // `bundle.resources` matching in a fresh clone.
  const readme = path.join(targetDir, README_NAME);
  if (await exists(readme)) {
    await copyFile(readme, path.join(stagingDir, README_NAME));
  }

  await rm(targetDir, { recursive: true, force: true });
  await rename(stagingDir, targetDir);
  await rm(extractDir, { recursive: true, force: true });
  console.log(`dictation: installed the runtime and model into ${targetDir}`);
}

main().catch((error) => {
  console.error(`dictation: predownload failed: ${error.message}`);
  process.exit(1);
});
