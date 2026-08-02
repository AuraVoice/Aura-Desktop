# Dictation runtime and model

This directory is populated at build time by
`scripts/predownload-dictation-model.mjs` (`npm run predownload:dictation`,
which `npm run build` also chains). Everything it drops here is gitignored:

- `sherpa-onnx-c-api.dll`, `onnxruntime.dll` from sherpa-onnx's prebuilt
  Windows x64 shared release, CPU provider only
- `encoder-*.int8.onnx`, `decoder-*.onnx`, `joiner-*.int8.onnx`, `tokens.txt`
  and, when the archive ships it, `bpe.vocab` from the streaming Zipformer 20M
  English model

`tauri.conf.json` bundles this whole directory through `bundle.resources`, so
the installed app resolves it locally and dictation never touches the network.

This file is committed so the resource glob always matches something, even in a
fresh clone that has not run the predownload yet.
