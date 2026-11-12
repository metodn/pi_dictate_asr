/**
 * Microphone capture backends, one entry per tool. To support a new platform or tool, add a
 * Backend to BACKENDS and list it in the platform's order in ORDER.
 *
 * Every backend must write raw mono 16 kHz signed 16-bit little-endian PCM to stdout.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

type Backend = { cmd: string; args: string[] };

const SOX_ARGS = ["-q", "-d", "-t", "raw", "-r", "16000", "-e", "signed-integer", "-b", "16", "-c", "1", "-"];

const BACKENDS: Record<string, Backend> = {
	parecord: { cmd: "parecord", args: ["--raw", "--latency-msec=30", "--channels=1", "--rate=16000", "--format=s16le"] },
	arecord: { cmd: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"] },
	sox: { cmd: "sox", args: SOX_ARGS },
};

/** Backends to try per platform, first one found on PATH wins. */
const ORDER: Record<string, string[]> = {
	linux: ["parecord", "sox", "arecord"],
	darwin: ["sox"],
	win32: ["sox"],
};

const INSTALL_HINT: Record<string, string> = {
	linux: "install pulseaudio-utils (parecord), alsa-utils (arecord) or sox",
	darwin: "brew install sox",
	win32: "winget install ChrisBagwell.SoX (or: choco install sox.portable), then restart the terminal",
};

function onPath(cmd: string): boolean {
	const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const ext of exts) if (existsSync(join(dir, cmd + ext))) return true;
	}
	return false;
}

/** The capture tool to use on this machine, or the hint for installing one. */
export function pickRecorder(): { backend: Backend } | { error: string } {
	const names = ORDER[process.platform] ?? ORDER.linux;
	for (const n of names) if (onPath(BACKENDS[n].cmd)) return { backend: BACKENDS[n] };
	const hint = INSTALL_HINT[process.platform] ?? INSTALL_HINT.linux;
	return { error: `no recording tool found (${names.map((n) => BACKENDS[n].cmd).join(", ")}): ${hint}` };
}

/** Start capturing; raw PCM arrives on the returned process's stdout. */
export function startCapture(backend: Backend): ChildProcess {
	return spawn(backend.cmd, backend.args, { stdio: ["ignore", "pipe", "ignore"] });
}

/** A recording that is all zero bytes: the usual symptom of a denied microphone permission (macOS). */
export function isSilent(pcm: Buffer): boolean {
	for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return false;
	return pcm.length > 0;
}
