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
// Idempotent: it exits immediately once every target file is present, so
// chaining it into `npm run build` costs nothing after the first run.

import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, copyFile, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHERPA_VERSION = "v1.10.46";
const MODEL_NAME = "sherpa-onnx-streaming-zipformer-en-20M-2023-02-17";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const targetDir = path.join(repoRoot, "src-tauri", "resources", "dictation");
const cacheDir = path.join(repoRoot, "node_modules", ".cache", "dictation");

const LIBS_ARCHIVE = `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared.tar.bz2`;
const LIBS_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA_VERSION}/${LIBS_ARCHIVE}`;
const MODEL_ARCHIVE = `${MODEL_NAME}.tar.bz2`;
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_ARCHIVE}`;

const REQUIRED = [
  "sherpa-onnx-c-api.dll",
  "onnxruntime.dll",
  "tokens.txt",
];

async function exists(candidate) {
  try {
    await stat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function alreadyInstalled() {
  for (const name of REQUIRED) {
    if (!(await exists(path.join(targetDir, name)))) {
      return false;
    }
  }
  const entries = await readdir(targetDir);
  const hasEncoder = entries.some((name) => name.startsWith("encoder") && name.endsWith(".onnx"));
  const hasDecoder = entries.some((name) => name.startsWith("decoder") && name.endsWith(".onnx"));
  const hasJoiner = entries.some((name) => name.startsWith("joiner") && name.endsWith(".onnx"));
  return hasEncoder && hasDecoder && hasJoiner;
}

async function download(url, destination) {
  if (await exists(destination)) {
    console.log(`dictation: reusing cached ${path.basename(destination)}`);
    return;
  }
  console.log(`dictation: downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  const partial = `${destination}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const { rename } = await import("node:fs/promises");
  await rename(partial, destination);
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

  const libsArchive = path.join(cacheDir, LIBS_ARCHIVE);
  const modelArchive = path.join(cacheDir, MODEL_ARCHIVE);
  await download(LIBS_URL, libsArchive);
  await download(MODEL_URL, modelArchive);

  const extractDir = path.join(cacheDir, "extract");
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  extract(libsArchive, extractDir);
  extract(modelArchive, extractDir);

  const libsDir = path.join(
    extractDir,
    `sherpa-onnx-${SHERPA_VERSION}-win-x64-shared`,
    "lib",
  );
  for (const name of ["sherpa-onnx-c-api.dll", "onnxruntime.dll"]) {
    await copyFile(path.join(libsDir, name), path.join(targetDir, name));
  }

  const modelDir = path.join(extractDir, MODEL_NAME);
  const encoder = await pickModelFile(modelDir, "encoder", true);
  const decoder = await pickModelFile(modelDir, "decoder", false);
  const joiner = await pickModelFile(modelDir, "joiner", true);
  for (const name of [encoder, decoder, joiner, "tokens.txt"]) {
    await copyFile(path.join(modelDir, name), path.join(targetDir, name));
  }

  // bpe.vocab is what sherpa-onnx needs to tokenize hotwords for a BPE English
  // model. Without it dictation still works, but tier 0 contextual biasing
  // turns itself off (dictation/stt.rs logs that once at startup).
  const bpeVocab = path.join(modelDir, "bpe.vocab");
  if (await exists(bpeVocab)) {
    await copyFile(bpeVocab, path.join(targetDir, "bpe.vocab"));
  } else {
    console.warn(
      "dictation: bpe.vocab is not in the model archive, contextual biasing will be off",
    );
  }

  await rm(extractDir, { recursive: true, force: true });
  console.log(`dictation: installed the runtime and model into ${targetDir}`);
}

main().catch((error) => {
  console.error(`dictation: predownload failed: ${error.message}`);
  process.exit(1);
});
