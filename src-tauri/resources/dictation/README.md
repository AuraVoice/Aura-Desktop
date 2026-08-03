# Dictation runtime and model

This directory is populated at build time by
`scripts/predownload-dictation-model.mjs` (`npm run predownload:dictation`,
which `npm run build` also chains). Everything it drops here is gitignored:

- `sherpa-onnx-c-api.dll`, `onnxruntime.dll` from sherpa-onnx's prebuilt
  Windows x64 shared release, CPU provider only
- `encoder-*.int8.onnx`, `decoder-*.onnx`, `joiner-*.int8.onnx`, `tokens.txt`
  and, when the archive ships it, `bpe.vocab` from the streaming Zipformer 20M
  English model
- `punct.int8.onnx` and `punct-bpe.vocab` from the English online punctuation
  model, which adds punctuation and restores capitals. The Zipformer above is
  LibriSpeech-trained, so its token table is entirely uppercase with no
  punctuation and it cannot emit anything else; this second model is what makes
  the inserted text readable. Both files are renamed on install because that
  archive also calls its vocabulary `bpe.vocab`, and everything lands in this
  one flat directory.

`tauri.conf.json` bundles this whole directory through `bundle.resources`, so
the installed app resolves it locally and dictation never touches the network.

This file is committed so the resource glob always matches something, even in a
fresh clone that has not run the predownload yet. The predownload script builds
its install in a staging directory and swaps the whole directory into place, so
it explicitly carries this file across rather than deleting it.
