/**
 * pi-dictate-asr: minimal hold-Space dictation for pi.
 *
 * Run /dictate to switch dictation on (again to switch it off; it is off at the start of each session).
 * Then hold Space (about half a second until key-repeat starts), speak, release. For hands-free
 * recording press Ctrl+R, speak (switch windows if you like), and press Ctrl+R or Enter to finish. The words you say are
 * typed into the prompt at the caret while you talk (start, middle or end of existing text) and
 * settle when you let go. Esc or Ctrl+C while holding removes them. A single Space still types a space.
 *
 * Audio is recorded with `parecord` (Linux) or `sox` (macOS, Windows; see src/recorder.ts) and sent as `input_audio` to an OpenAI-style
 * /v1/chat/completions endpoint (llama-swap serving an LFM3-Audio model). No other server is
 * needed. Each decode re-sends the growing audio, so the text refines as you speak.
 *
 * Servers live in ~/.pi/agent/pi-dictate-asr.json (see README). Without that file there is one:
 *   local  http://localhost:8181   lfm3-audio-2b
 * With several, the active one is tried first and the others are tried when it fails.
 *
 *   /dictate                    switch Space-hold dictation on or off
 *   /dictate help               keys and commands
 *   /dictate info               (any other argument) servers and state, changes nothing
 *   /dictate use <name>         make a server the active one (saved)
 *   /dictate add <name> <host[:port]|url> [model] [key=<API key>]   add a server (saved; model defaults to lfm3-audio-2b)
 *   /dictate remove <name>      drop a server (saved)
 *
 * Try without installing:  pi --no-extensions -e ./extensions/pi-dictate-asr.ts
 */
import { type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isSilent, pickRecorder, startCapture } from "../src/recorder.ts";

type Server = { name: string; url: string; model: string; apiKey?: string };
type Config = { servers: Server[]; active: string };

const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-dictate-asr.json");
const DEFAULTS: Config = {
	active: "local",
	servers: [{ name: "local", url: "http://localhost:8181", model: "lfm3-audio-2b" }],
};

const REPEAT_MS = 120; // spaces closer than this are a held key, not typing
const RELEASE_MS = 150; // no space for this long = released
const STEP_BYTES = 32000; // re-decode after this much new audio (1 s of 16 kHz s16le)
const MIN_BYTES = 9600; // 0.3 s
const SEGMENT_BYTES = 32000 * 40; // commit the text so far every 40 s (models take clips up to ~60 s)
const WIDGET = "pi-dictate-asr";
const TOGGLE_KEY = "ctrl+r"; // hands-free recording on/off (unused by pi's editor)

function loadConfig(): Config {
	try {
		const c = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
		if (Array.isArray(c.servers) && c.servers.length) {
			return { servers: c.servers, active: c.active && c.servers.some((s) => s.name === c.active) ? c.active : c.servers[0].name };
		}
	} catch {}
	return structuredClone(DEFAULTS);
}

function saveConfig(c: Config): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 }); // may hold API keys
	try {
		chmodSync(CONFIG_PATH, 0o600); // also for a file created earlier with looser rights
	} catch {}
}

// ------------------------------------------------------------------ audio + decode

/**
 * Drop everything before the speech starts (the model invents words from room noise and clicks).
 * Speech = two loud 100 ms windows in a row, "loud" being a small fraction of the clip's peak; half a second of lead-in is kept.
 * Returns empty if there is none.
 */
function trimSilence(pcm: Buffer): Buffer {
	const win = 3200; // 100 ms
	const rms: number[] = [];
	for (let i = 0; i + win <= pcm.length; i += win) {
		let sum = 0;
		for (let j = i; j < i + win; j += 2) {
			const v = pcm.readInt16LE(j);
			sum += v * v;
		}
		rms.push(Math.sqrt(sum / (win / 2)));
	}
	// Adaptive: well above the room-noise floor (20th percentile) and a small fraction of the peak.
	const sorted = [...rms].sort((a, b) => a - b);
	const noise = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
	const threshold = Math.max(80, 3 * noise, 0.05 * Math.max(0, ...rms));
	for (let k = 0; k + 1 < rms.length; k++) {
		if (rms[k] > threshold && rms[k + 1] > threshold) return pcm.subarray(Math.max(0, (k - 5) * win));
	}
	return Buffer.alloc(0);
}

function wav(pcm: Buffer): Buffer {
	const h = Buffer.alloc(44);
	h.write("RIFF", 0);
	h.writeUInt32LE(36 + pcm.length, 4);
	h.write("WAVEfmt ", 8);
	h.writeUInt32LE(16, 16);
	h.writeUInt16LE(1, 20); // PCM
	h.writeUInt16LE(1, 22); // mono
	h.writeUInt32LE(16000, 24);
	h.writeUInt32LE(32000, 28);
	h.writeUInt16LE(2, 32);
	h.writeUInt16LE(16, 34);
	h.write("data", 36);
	h.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([h, pcm]);
}

/** Request headers for a server; adds the bearer token when the server has an apiKey. */
const authHeaders = (s: Server): Record<string, string> => (s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {});

async function decodeWith(s: Server, pcm: Buffer): Promise<string> {
	const res = await fetch(`${s.url}/v1/chat/completions`, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...authHeaders(s) },
		signal: AbortSignal.timeout(60_000),
		body: JSON.stringify({
			model: s.model,
			temperature: 0,
			max_tokens: 1024,
			messages: [
				{ role: "system", content: "Perform ASR." },
				{ role: "user", content: [{ type: "input_audio", input_audio: { data: wav(pcm).toString("base64"), format: "wav" } }] },
			],
		}),
	});
	if (!res.ok) throw new Error(`${s.name}: HTTP ${res.status}`);
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	return (json.choices?.[0]?.message?.content ?? "").replace(/<_*media_*>/g, "").trim();
}

// ------------------------------------------------------------------ the extension

export default function (pi: ExtensionAPI) {
	let cfg = loadConfig();
	let unsubscribe: (() => void) | undefined;
	let lastUsed = ""; // server that answered the latest decode
	let enabled = false; // set by /dictate; Space is left completely alone while off

	// The editor instance, so the transcript can go in at the caret.
	let editor: CustomEditor | undefined;
	let requestRender: (() => void) | undefined;
	class AsrEditor extends CustomEditor {
		constructor(...args: ConstructorParameters<typeof CustomEditor>) {
			super(...args);
			editor = this;
			requestRender = () => args[0].requestRender();
		}
	}

	// recording state
	let rec: ChildProcess | undefined;
	let pcm: Buffer[] = [];
	let bytes = 0;
	let segStart = 0; // byte offset where the current 40 s segment begins
	const committed: string[] = [];
	let segText = "";
	let decodedBytes = 0;
	let decoding = false;
	let discarded = false; // Esc pressed: ignore decodes still in flight
	let ticker: ReturnType<typeof setInterval> | undefined;

	// hold detection state
	let spaceRun = 0; // spaces typed so far in this chain
	let lastSpaceAt = 0;
	let isHeld = false;
	let latched = false; // hands-free recording: started with Ctrl+R, ended with Ctrl+R or Enter
	let releaseTimer: ReturnType<typeof setInterval> | undefined;

	const ordered = (): Server[] => {
		const first = cfg.servers.find((s) => s.name === cfg.active) ?? cfg.servers[0];
		return [first, ...cfg.servers.filter((s) => s !== first)];
	};

	/** Decode with the active server; on failure fall back to the next ones. */
	async function decode(ctx: ExtensionContext, audio: Buffer): Promise<string> {
		let lastErr: unknown;
		for (const s of ordered()) {
			try {
				const out = await decodeWith(s, audio);
				lastUsed = s.name;
				return out;
			} catch (e) {
				lastErr = e;
			}
		}
		throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
	}

	const transcript = () => [...committed, segText].filter(Boolean).join(" ");
	const audioNow = () => Buffer.concat(pcm);

	/** Footer indicator only; the words themselves go into the prompt. */
	function indicator(ctx: ExtensionContext, state: "rec" | "wait" | "off"): void {
		const t = ctx.ui.theme;
		if (state === "rec") ctx.ui.setStatus(WIDGET, t.fg("error", "● REC") + t.fg("dim", latched ? " Ctrl+R or Enter to finish, Esc cancels" : " release Space, Esc cancels"));
		else if (state === "wait") ctx.ui.setStatus(WIDGET, t.fg("warning", "◌ transcribing…"));
		else if (!enabled) ctx.ui.setStatus(WIDGET, undefined);
		else ctx.ui.setStatus(WIDGET, lastUsed && lastUsed !== cfg.active ? `asr: ${lastUsed} (fallback, ${cfg.active} failed)` : `asr: ${cfg.active}`);
	}

	// ---- live text in the prompt -------------------------------------------------------
	// `live.shown` is exactly what we typed at the caret ("pre + words"); the caret stays at its end.
	// `post` is a space we added after the caret so the words do not glue to the text that follows.
	let live: { pre: string; post: string; shown: string; expect: string; abandoned: boolean } | undefined;

	function beginLive(): void {
		if (!editor) return;
		const { line, col } = editor.getCursor();
		const cur = editor.getLines()[line] ?? "";
		const b = cur[col - 1];
		const a = cur[col];
		live = { pre: b && !/\s/.test(b) ? " " : "", post: a && !/\s/.test(a) ? " " : "", shown: "", expect: editor.getText(), abandoned: false };
	}

	const keys = (k: string, n: number) => {
		for (let i = 0; i < n; i++) editor?.handleInput(k);
	};

	/** Make the typed words equal `words`, retyping only the part that changed. */
	function setLive(words: string): void {
		const l = live;
		if (!editor || !l || l.abandoned) return;
		if (editor.getText() !== l.expect) {
			l.abandoned = true; // the person edited the prompt meanwhile: hands off
			return;
		}
		const next = words ? l.pre + words : "";
		if (next !== l.shown) {
			if (!l.shown && next) {
				editor.insertTextAtCursor(next + l.post);
				keys("\x1b[D", l.post.length); // caret back before the trailing space
			} else if (l.shown && !next) {
				keys("\x7f", l.shown.length); // remove our words
				keys("\x1b[3~", l.post.length); // and the space after them
			} else {
				let k = 0;
				while (k < l.shown.length && k < next.length && l.shown[k] === next[k]) k++;
				keys("\x7f", l.shown.length - k);
				if (next.length > k) editor.insertTextAtCursor(next.slice(k));
			}
			l.shown = next;
			l.expect = editor.getText();
			requestRender?.();
		}
	}

	async function refine(ctx: ExtensionContext): Promise<void> {
		const all = audioNow();
		decodedBytes = all.length;
		const voiced = trimSilence(all.subarray(segStart));
		if (voiced.length < MIN_BYTES) {
			segText = "";
			return;
		}
		segText = await decode(ctx, voiced);
		if (!discarded) setLive(transcript());
		if (all.length - segStart > SEGMENT_BYTES) {
			// long speech: lock in what we have and start a fresh segment
			if (segText) committed.push(segText);
			segText = "";
			segStart = all.length;
		}
	}

	/** Insert text at the caret, adding a space on either side only where it would glue to a word. */
	function insertAtCaret(ctx: ExtensionContext, text: string): void {
		if (!editor) {
			ctx.ui.pasteToEditor(text);
			return;
		}
		const { line, col } = editor.getCursor();
		const cur = editor.getLines()[line] ?? "";
		const before = cur[col - 1];
		const after = cur[col];
		const pre = before && !/\s/.test(before) ? " " : "";
		const post = after && !/\s/.test(after) ? " " : "";
		editor.insertTextAtCursor(pre + text + post);
		requestRender?.();
	}

	function startRecording(ctx: ExtensionContext): boolean {
		pcm = [];
		bytes = 0;
		segStart = 0;
		committed.length = 0;
		segText = "";
		decodedBytes = 0;
		discarded = false;
		const picked = pickRecorder();
		if ("error" in picked) {
			ctx.ui.notify(`asr: ${picked.error}`, "error");
			return false;
		}
		beginLive();
		rec = startCapture(picked.backend);
		rec.stdout?.on("data", (d: Buffer) => {
			pcm.push(d);
			bytes += d.length;
		});
		rec.on("error", (e) => ctx.ui.notify(`asr: cannot record with ${picked.backend.cmd} (${e.message})`, "error"));
		indicator(ctx, "rec");
		ticker = setInterval(() => {
			if (decoding || bytes - decodedBytes < STEP_BYTES) return;
			decoding = true;
			refine(ctx)
				.catch((e) => ctx.ui.notify(`asr: ${e.message}`, "error"))
				.finally(() => (decoding = false));
		}, 200);
		return true;
	}

	async function stopRecording(ctx: ExtensionContext, discard: boolean): Promise<void> {
		const proc = rec;
		if (!proc) return;
		rec = undefined;
		if (ticker) clearInterval(ticker);
		discarded = discard;
		const closed = new Promise<void>((r) => proc.once("close", () => r()));
		proc.kill("SIGTERM");
		await closed;
		if (discard) {
			while (decoding) await new Promise((r) => setTimeout(r, 50));
			setLive(""); // take our words back out
			indicator(ctx, "off");
			live = undefined;
			return;
		}
		indicator(ctx, "wait");
		try {
			while (decoding) await new Promise((r) => setTimeout(r, 50)); // let a decode in flight finish
			if (bytes - decodedBytes > 4800 || !transcript()) await refine(ctx);
			const final = transcript();
			if (!final) {
				setLive("");
				ctx.ui.notify(
					isSilent(audioNow())
						? "asr: the microphone delivered only silence. Check the microphone permission of this terminal."
						: "asr: no speech heard",
					"info",
				);
			} else if (live && !live.abandoned) {
				setLive(final);
				if (live.abandoned) insertAtCaret(ctx, final);
				else keys("\x1b[C", live.post.length); // finish after the trailing space so typing flows on
			} else insertAtCaret(ctx, final);
		} catch (e) {
			setLive("");
			ctx.ui.notify(`asr: ${(e as Error).message}`, "error");
		} finally {
			live = undefined;
			indicator(ctx, "off");
		}
	}

	// ------------------------------------------------------------------ Space hold

	function onInput(ctx: ExtensionContext) {
		return (data: string): { consume?: boolean } | undefined => {
			if (!enabled) return undefined;
			if (!isHeld && matchesKey(data, TOGGLE_KEY)) {
				if (latched) {
					latched = false;
					void stopRecording(ctx, false);
				} else if (!rec) {
					latched = true; // before starting, so the status line shows the right hint
					latched = startRecording(ctx);
				}
				return { consume: true };
			}
			if (latched && matchesKey(data, "enter")) {
				latched = false;
				void stopRecording(ctx, false);
				return { consume: true };
			}
			if ((isHeld || latched) && (data === "\x1b" || data === "\x03")) {
				isHeld = false;
				latched = false;
				if (releaseTimer) clearInterval(releaseTimer);
				void stopRecording(ctx, true);
				return { consume: true };
			}
			if (latched) return undefined; // spaces are ordinary typing during a hands-free recording
			const isSpace = data === " " || /^ {2,}$/.test(data) || data === "\x1b[32u";
			if (!isSpace) {
				spaceRun = 0;
				return undefined;
			}
			const now = performance.now();
			const gap = now - lastSpaceAt;
			lastSpaceAt = now;
			if (isHeld) return { consume: true };

			const burst = data.length >= 3;
			if (!burst && !(spaceRun >= 2 && gap < REPEAT_MS)) {
				spaceRun += data.length;
				return undefined; // an ordinary space: let the editor type it
			}

			// Held: the editor already typed `spaceRun` spaces at the caret. Delete exactly those
			// (Backspace through the editor, so it works wherever the caret is), then record.
			for (let i = 0; i < spaceRun; i++) editor?.handleInput("\x7f");
			spaceRun = 0;
			isHeld = true;
			startRecording(ctx);
			releaseTimer = setInterval(() => {
				if (performance.now() - lastSpaceAt < RELEASE_MS) return;
				if (releaseTimer) clearInterval(releaseTimer);
				isHeld = false;
				void stopRecording(ctx, false);
			}, 50);
			requestRender?.();
			return { consume: true };
		};
	}

	// ------------------------------------------------------------------ wiring

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		cfg = loadConfig();
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new AsrEditor(tui, theme, keybindings));
		unsubscribe?.();
		unsubscribe = ctx.ui.onTerminalInput(onInput(ctx));
		indicator(ctx, "off");
	});

	pi.on("session_shutdown", async () => {
		unsubscribe?.();
		unsubscribe = undefined;
		if (ticker) clearInterval(ticker);
		if (releaseTimer) clearInterval(releaseTimer);
		rec?.kill("SIGTERM");
	});

	/** One line per server: active marker, url, model, and whether it serves that model. */
	async function serverReport(): Promise<string> {
		const rows = await Promise.all(
			cfg.servers.map(async (s) => {
				// Ask the server which models it serves: that tells "listening" from "has no such API/model".
				const state = await fetch(`${s.url}/v1/models`, { headers: authHeaders(s), signal: AbortSignal.timeout(2500) }).then(
					async (r) => {
						if (r.status === 401 || r.status === 403) return s.apiKey ? "API key rejected" : "needs an API key";
						if (!r.ok) return "no models API yet";
						const j = (await r.json().catch(() => ({}))) as { data?: { id: string }[] };
						return j.data?.some((m) => m.id === s.model) ? "ready" : "model not listed";
					},
					() => "down",
				);
				return [`${s.name === cfg.active ? "*" : " "} ${s.name.padEnd(8)} ${s.url}  ${s.model}${s.apiKey ? "  (key)" : ""}  [${state}]`, `/dictate use ${s.name}`];
			}),
		);
		const w = Math.max(...rows.map((r) => r[0].length));
		return rows.map(([info, hint]) => `${info.padEnd(w)}  |  ${hint}`).join("\n");
	}

	const HELP = [
		"dictation (pi-dictate-asr)",
		"  Hold Space      speak while held, release to finish. Words appear at the caret.",
		"  Ctrl+R          hands-free: start recording, switch windows, come back, press Ctrl+R or Enter to finish.",
		"  Esc / Ctrl+C    cancel the running recording and remove its words.",
		"  Typing in the prompt while a recording runs stops the live update; the words are then inserted at the caret when you finish.",
		"  /dictate               switch dictation on or off (off at each start)",
		"  /dictate info          state and servers, with [ready] / [down]",
		"  /dictate use <name>    choose the server tried first; the others are fallbacks",
		"  /dictate add <name> <host[:port]|url> [model] [key=<API key>]    /dictate remove <name>",
		"  A server behind an API key: add key=<token>, or set \"apiKey\" in the config file (sent as a Bearer token).",
		"  Status bar: asr: <server> (fallback = the active one failed).",
		"  No sound or only silence: check the recording tool (parecord or sox) and the terminal's microphone permission.",
	].join("\n");

	pi.registerCommand("dictate", {
		description: "Dictation on/off (hold Space, or Ctrl+R hands-free). Arguments: help | info | use <name> | add <name> <host[:port]> [model] [key=<token>] | remove <name>",
		handler: async (args, ctx) => {
			const [verb, name] = (args ?? "").trim().split(/\s+/);
			if (verb === "help") {
				ctx.ui.notify(HELP, "info");
				return;
			}
			if (verb === "use") {
				if (!cfg.servers.some((s) => s.name === name)) {
					ctx.ui.notify(`asr: no server "${name}". Known: ${cfg.servers.map((s) => s.name).join(", ")}`, "error");
					return;
				}
				cfg.active = name;
				saveConfig(cfg);
				ctx.ui.setStatus(WIDGET, `asr: ${name}`);
				ctx.ui.notify(`asr: using ${name}`, "info");
				return;
			}
			if (verb === "add") {
				const [, , addr, ...rest] = (args ?? "").trim().split(/\s+/);
				if (!name || !addr) {
					ctx.ui.notify("usage: /dictate add <name> <host[:port]|url> [model] [key=<API key>]", "error");
					return;
				}
				const model = rest.find((t) => !t.startsWith("key="));
				const keyArg = rest.find((t) => t.startsWith("key="))?.slice(4);
				const url = (/^https?:\/\//.test(addr) ? addr : `http://${addr}`).replace(/\/+$/, "");
				const i = cfg.servers.findIndex((s) => s.name === name);
				const apiKey = keyArg ?? (i >= 0 ? cfg.servers[i].apiKey : undefined); // re-adding keeps the saved key
				const entry: Server = { name, url, model: model ?? DEFAULTS.servers[0].model, ...(apiKey ? { apiKey } : {}) };
				if (i >= 0) cfg.servers[i] = entry;
				else cfg.servers.push(entry);
				saveConfig(cfg);
				ctx.ui.notify(`asr: ${i >= 0 ? "updated" : "added"} ${name} (${url}, ${entry.model})\n${await serverReport()}`, "info");
				return;
			}
			if (verb === "remove") {
				if (cfg.servers.length < 2 || !cfg.servers.some((s) => s.name === name)) {
					ctx.ui.notify(`asr: cannot remove "${name}" (unknown, or the only server)`, "error");
					return;
				}
				cfg.servers = cfg.servers.filter((s) => s.name !== name);
				if (cfg.active === name) cfg.active = cfg.servers[0].name;
				saveConfig(cfg);
				ctx.ui.notify(`asr: removed ${name}; active: ${cfg.active}`, "info");
				return;
			}
			if ((args ?? "").trim()) {
				ctx.ui.notify(`dictation: ${enabled ? "ON (hold Space)" : "off"}\n${await serverReport()}`, "info");
				return;
			}
			enabled = !enabled;
			if (!enabled && rec) {
				isHeld = false;
				latched = false;
				if (releaseTimer) clearInterval(releaseTimer);
				await stopRecording(ctx, true);
			}
			spaceRun = 0;
			indicator(ctx, "off");
			ctx.ui.notify(
				(enabled ? "dictation ON: hold Space and speak, or Ctrl+R for hands-free. /dictate help for more, /dictate again to switch off." : "dictation off: Space types normally again.") +
					`\nservers (* = active):\n${await serverReport()}`,
				"info",
			);
		},
	});
}
