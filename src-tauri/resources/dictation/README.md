# Dictation runtime and model

This directory is populated at build time by
`scripts/predownload-dictation-model.mjs` (`npm run predownload:dictation`,
which `npm run build` also chains). Runtime and model artifacts are gitignored:

- `sherpa-onnx-c-api.dll`, `onnxruntime.dll`, and the shared CPU provider from
  sherpa-onnx's prebuilt Windows x64 release
- `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, and `tokens.txt`
  from the cache-aware 560 ms Nemotron streaming English model

`tauri.conf.json` bundles this whole directory through `bundle.resources`, so
the installed app resolves it locally and dictation never touches the network.

This file is committed so the resource glob always matches something in a
fresh clone. The predownload script carries it through its atomic staging swap.
