# pi-dictate-asr

Local, private dictation for the pi coding agent. Run
`/dictate` once, then hold **Space**, speak, and release: the words are typed into the prompt at the
caret while you talk and settle when you let go. For longer pauses or reading in another window,
press **Ctrl+R** to record hands-free and **Ctrl+R** or **Enter** to finish. Speech is transcribed by an audio model served by
[llama-swap](https://github.com/mostlygeek/llama-swap) on your own machine, so no audio goes to a
cloud service.

It is a small pi extension (one main file plus a recorder module, about 600 lines of TypeScript) with no dependencies of its own.

## Requirements

- **pi** (developed and tested on 1.5.0, Linux).
- **A recording tool on the PATH** and a working microphone (picked automatically, see `src/recorder.ts`):
  - Linux: `parecord` (PulseAudio or PipeWire), else `sox`, else `arecord`.
  - macOS: `brew install sox`. Give your terminal app microphone permission (System Settings >
    Privacy & Security > Microphone); without it the recording is silent and the extension says so.
  - Windows: `winget install ChrisBagwell.SoX` (or `choco install sox.portable`). macOS and Windows are
    not yet tested with this extension.
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

**From a local clone** (edits take effect on the next pi start):

```bash
git clone https://github.com/metodn/pi_dictate_asr.git
pi install ./pi_dictate_asr
```

The extension needs `src/recorder.ts` next to `extensions/`, so copying only the one `.ts` file does
not work. Restart pi, or run `/reload`, after installing.

**Conflicts:** another extension that also reacts to the Space key (for example a different
dictation extension) will fight with this one. Disable it with `pi config`, or load only this one
for a session with `pi --no-extensions -e git:github.com/metodn/pi_dictate_asr`.

To remove it: `pi remove git:github.com/metodn/pi_dictate_asr` (or `pi remove ./pi_dictate_asr` for a local clone).

## Use

| Command | What it does |
| --- | --- |
| `/dictate` | Switch dictation on or off, and list the servers (`*` marks the active one, with `[ready]` / `[down]` and the command to switch to each). It is **off at the start of every session**, so Space types normally until you run it. |
| `/dictate help` | Show the keys and commands. |
| `/dictate info` | Show the same server list without switching anything. |
| `/dictate use <name>` | Make a server the active one (saved in `~/.pi/agent/pi-dictate-asr.json`). |
| `/dictate add <name> <host[:port]\|url> [model] [key=<API key>]` | Add (or update) a server, saved to the config file. Model defaults to `lfm3-audio-2b`. `key=` is for a server that requires an API key; re-adding without `key=` keeps the saved key. |
| `/dictate remove <name>` | Remove a server (the last one cannot be removed). |

With dictation on:

1. Press and **hold Space**. A normal tap still types a space. Recording starts after the terminal's
   key-repeat delay (about half a second); the footer shows `● REC`.
2. Speak. The words appear in the prompt as the model refines them, at the caret: at the start, in
   the middle or at the end of text you already wrote.
3. **Release Space.** The text is finalized and the caret finishes after it.
4. **Esc** or **Ctrl+C** while holding cancels and removes what was typed.

**Hands-free:** press **Ctrl+R** to start recording without holding anything, for example to switch
to another window and read while you talk. The footer shows `● REC Ctrl+R or Enter to finish`. Come
back and press **Ctrl+R** or **Enter** (Enter does not send the prompt) to finish; **Esc** cancels.
Space types normally during a hands-free recording. Ctrl+R is not used by pi's prompt editor; it is
only taken while dictation is on.

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
- `apiKey` (optional, per server) is sent as `Authorization: Bearer <apiKey>`, for a llama-swap or proxy
  that requires a key. The server list shows `(key)` for such a server, `[needs an API key]` when one
  is required but missing, and `[API key rejected]` when it is wrong. The file is stored with mode 600;
  keys are kept in plain text, so do not commit or share it.
- `model` is the model name sent in the request. Use the name your server exposes.
- `/dictate info` shows `[ready]` for a server that lists its model in `/v1/models`, `[model not
  listed]` for one that is up but does not, and `[down]` for one that does not answer.

## How it works

- Space handling uses pi's raw terminal input hook. Terminals send no key release, so a held key is
  detected from its auto-repeat: three spaces in quick succession are a hold, and 150 ms without one
  is a release. The repeats are swallowed before the editor sees them, so the cursor does not move.
- The one or two spaces typed before the hold is recognised are deleted again through the editor,
  so it works wherever the caret is.
- Audio is recorded (`parecord`, `arecord` or `sox`, chosen per platform in `src/recorder.ts`; adding a
  tool or platform is one entry there) at 16 kHz mono and re-sent to the server about once a second as a
  growing WAV, so the text refines while you speak. Leading silence is trimmed to stop the model
  inventing words from room noise. Long dictation is committed in 40 second segments.
- The words are inserted with the editor's own `insertTextAtCursor`; only the part that changed is
  retyped on each update.

## Privacy

Audio is recorded locally and sent only to the server URLs you configure. With the default
configuration that is `localhost`. Nothing is written to disk except the optional config file.

## Limitations

- Only Linux with `parecord` is tested here. The macOS and Windows `sox` paths are untested.
- A hands-free recording keeps all its audio in memory (about 2 MB per minute) until you finish it.
- Recording starts about half a second after Space goes down (the key-repeat delay), so a word
  spoken the instant you press is lost.
- For the first half second of a hold, one or two spaces appear in the prompt and are then removed.
- The dictated words cannot be dimmed while they are provisional: the editor has no way to style
  typed text.
- Short or quiet speech can be misheard, and the model sometimes shortens long dictation.

## License

MIT
