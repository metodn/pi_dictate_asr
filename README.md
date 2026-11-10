# pi-dictate-asr

Local, private dictation for the pi coding agent. Run
`/dictate` once, then hold **Space**, speak, and release: the words are typed into the prompt at the
caret while you talk and settle when you let go. Speech is transcribed by an audio model served by
[llama-swap](https://github.com/mostlygeek/llama-swap) on your own machine, so no audio goes to a
cloud service.

It is a single pi extension, about 463 lines of TypeScript, with no dependencies of its own.

## Requirements

- **pi** (developed and tested on 1.5.0, Linux).
- **PulseAudio or PipeWire** with `parecord` on the PATH, and a working microphone.
- **A llama-swap server** (default `http://localhost:8181`) that serves an audio-input chat model
  through `/v1/chat/completions` with `input_audio` content. The default model name is
  `lfm3-audio-2b` (LFM3-Audio served by llama.cpp); any model that transcribes `input_audio` works,
  see [Configuration](#configuration).

## Install

Pick one.

**From GitHub (recommended).** This installs it for your user and keeps it updated with
`pi update --extensions`:

```bash
pi install git:github.com/metodn/pi_dictate_asr
```

Pin a release instead by adding a tag: `pi install git:github.com/metodn/pi_dictate_asr@v0.1.0`.

**Try it for one session, without installing:**

```bash
pi -e git:github.com/metodn/pi_dictate_asr
```

**Manual copy.** Put the single file where pi discovers extensions:

```bash
mkdir -p ~/.pi/agent/extensions
curl -fsSL https://raw.githubusercontent.com/metodn/pi_dictate_asr/main/extensions/pi-dictate-asr.ts \
  -o ~/.pi/agent/extensions/pi-dictate-asr.ts
```

Then restart pi, or run `/reload`.

**Conflicts:** another extension that also reacts to the Space key (for example a different
dictation extension) will fight with this one. Disable it with `pi config`, or load only this one
for a session with `pi --no-extensions -e git:github.com/metodn/pi_dictate_asr`.

To remove it: `pi remove git:github.com/metodn/pi_dictate_asr` (or delete the copied file).

## Use

| Command | What it does |
| --- | --- |
| `/dictate` | Switch dictation on or off. It is **off at the start of every session**, so Space types normally until you run it. |
| `/dictate info` (any argument) | Show whether dictation is on, and the configured servers with whether each is reachable and serves the model. Changes nothing. |
| `/dictate use <name>` | Make a server the active one (saved in `~/.pi/agent/pi-dictate-asr.json`). |
| `/dictate add <name> <host[:port]\|url> [model]` | Add (or update) a server, saved to the config file. Model defaults to `lfm3-audio-2b`. |
| `/dictate remove <name>` | Remove a server (the last one cannot be removed). |

With dictation on:

1. Press and **hold Space**. A normal tap still types a space. Recording starts after the terminal's
   key-repeat delay (about half a second); the footer shows `● REC`.
2. Speak. The words appear in the prompt as the model refines them, at the caret: at the start, in
   the middle or at the end of text you already wrote.
3. **Release Space.** The text is finalized and the caret finishes after it.
4. **Esc** or **Ctrl+C** while holding cancels and removes what was typed.

## Configuration

Without a config file there is one server, `local` at `http://localhost:8181` using the model
`lfm3-audio-2b`. To change that, or to add more servers, create `~/.pi/agent/pi-dictate-asr.json`:

```json
{
  "active": "local",
  "servers": [
    { "name": "local", "url": "http://localhost:8181", "model": "lfm3-audio-2b" },
    { "name": "desk", "url": "http://desk.local:8181", "model": "lfm3-audio-2b" }
  ]
}
```

- The `active` server is tried first. If a request to it fails (connection error or an HTTP error),
  the others are tried in order, and the footer shows `asr: desk (fallback, local failed)`.
- `model` is the model name sent in the request. Use the name your server exposes.
- `/dictate info` shows `[ready]` for a server that lists its model in `/v1/models`, `[model not
  listed]` for one that is up but does not, and `[down]` for one that does not answer.

## How it works

- Space handling uses pi's raw terminal input hook. Terminals send no key release, so a held key is
  detected from its auto-repeat: three spaces in quick succession are a hold, and 150 ms without one
  is a release. The repeats are swallowed before the editor sees them, so the cursor does not move.
- The one or two spaces typed before the hold is recognised are deleted again through the editor,
  so it works wherever the caret is.
- Audio is recorded with `parecord` at 16 kHz mono and re-sent to the server about once a second as a
  growing WAV, so the text refines while you speak. Leading silence is trimmed to stop the model
  inventing words from room noise. Long dictation is committed in 40 second segments.
- The words are inserted with the editor's own `insertTextAtCursor`; only the part that changed is
  retyped on each update.

## Privacy

Audio is recorded locally and sent only to the server URLs you configure. With the default
configuration that is `localhost`. Nothing is written to disk except the optional config file.

## Limitations

- Linux with `parecord` only; not tested elsewhere.
- Recording starts about half a second after Space goes down (the key-repeat delay), so a word
  spoken the instant you press is lost.
- For the first half second of a hold, one or two spaces appear in the prompt and are then removed.
- The dictated words cannot be dimmed while they are provisional: the editor has no way to style
  typed text.
- Short or quiet speech can be misheard, and the model sometimes shortens long dictation.

## License

MIT
