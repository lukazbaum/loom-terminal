/// Plays a short sound when an agent/hook finishes a turn. Driven by
/// settings (`notificationSoundEnabled` + preset/volume/custom path) and
/// called from `markPaneUnread` so the audio rides the same gate as the
/// sidebar mint pulse — including the active-and-at-bottom suppression.
///
/// Built-in presets are synthesized via the Web Audio API (no bundled
/// assets, no licensing). Custom sounds go through an HTMLAudioElement
/// fed via Tauri's `convertFileSrc` so arbitrary on-disk files play in
/// the webview.

import { convertFileSrc } from "@tauri-apps/api/core";
import { getSettings } from "./settings";

export type SoundPreset = "ding" | "chime" | "beep" | "pop";

export const SOUND_PRESET_IDS: readonly SoundPreset[] = [
  "ding",
  "chime",
  "beep",
  "pop",
] as const;

export const SOUND_PRESET_LABELS: Record<SoundPreset, string> = {
  ding: "Ding",
  chime: "Chime",
  beep: "Beep",
  pop: "Pop",
};

type Tone = {
  freq: number;
  type: OscillatorType;
  delay: number;
  duration: number;
};

// One or two enveloped oscillators per preset. Kept short (<0.5s) so a
// burst of completions doesn't pile into a drone.
const RECIPES: Record<SoundPreset, Tone[]> = {
  ding: [
    { freq: 880, type: "sine", delay: 0, duration: 0.25 },
    { freq: 1320, type: "sine", delay: 0, duration: 0.18 },
  ],
  chime: [
    { freq: 698, type: "triangle", delay: 0, duration: 0.45 },
    { freq: 1047, type: "triangle", delay: 0.12, duration: 0.45 },
  ],
  beep: [{ freq: 880, type: "square", delay: 0, duration: 0.12 }],
  pop: [{ freq: 660, type: "sine", delay: 0, duration: 0.08 }],
};

// Lazy so we only construct the context when the user has actually
// enabled sound. Browsers wake a suspended context on the first user
// gesture (click on the Settings toggle / Preview button counts).
let audioCtx: AudioContext | null = null;
function getAudioCtx(): AudioContext | null {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === "suspended") void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function clampVol(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function synth(preset: SoundPreset, volume: number): void {
  const ctx = getAudioCtx();
  if (!ctx) return;
  // Wrapped in case a Web Audio call throws (e.g. context closed by the
  // OS, allocation failure). A missing sound is fine; an unhandled
  // throw would propagate through `markPaneUnread` and pollute logs.
  try {
    const master = ctx.createGain();
    master.gain.value = clampVol(volume);
    master.connect(ctx.destination);

    const now = ctx.currentTime;
    for (const tone of RECIPES[preset]) {
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = tone.type;
      osc.frequency.setValueAtTime(tone.freq, now + tone.delay);
      // "pop" is a quick pitch drop — gives the impulse a tail without
      // dragging the duration out.
      if (preset === "pop") {
        osc.frequency.exponentialRampToValueAtTime(
          180,
          now + tone.delay + tone.duration,
        );
      }
      // 5ms attack, exponential decay. exponentialRampToValueAtTime
      // can't hit 0, so target a tiny positive value.
      env.gain.setValueAtTime(0, now + tone.delay);
      env.gain.linearRampToValueAtTime(1, now + tone.delay + 0.005);
      env.gain.exponentialRampToValueAtTime(
        0.0001,
        now + tone.delay + tone.duration,
      );
      osc.connect(env);
      env.connect(master);
      osc.start(now + tone.delay);
      osc.stop(now + tone.delay + tone.duration + 0.02);
    }
  } catch (err) {
    console.warn("[loom] notification sound (synth) failed", err);
  }
}

// One cached element per resolved custom-file path. Reused across plays
// to skip redecoding; replaced when the path changes.
let customAudioCache: { path: string; el: HTMLAudioElement } | null = null;

function getCustomAudio(path: string): HTMLAudioElement | null {
  if (customAudioCache?.path === path) return customAudioCache.el;
  try {
    const el = new Audio(convertFileSrc(path));
    el.preload = "auto";
    customAudioCache = { path, el };
    return el;
  } catch {
    return null;
  }
}

function playCustom(path: string, volume: number): void {
  const el = getCustomAudio(path);
  if (!el) return;
  try {
    el.currentTime = 0;
    el.volume = clampVol(volume);
    void el.play().catch((err) => {
      console.warn("[loom] notification sound failed", err);
    });
  } catch (err) {
    console.warn("[loom] notification sound failed", err);
  }
}

export type PreviewOpts = {
  preset: SoundPreset | "custom";
  customPath: string | null;
  volume: number;
};

export function previewSound(opts: PreviewOpts): void {
  if (opts.preset === "custom") {
    if (opts.customPath) playCustom(opts.customPath, opts.volume);
    return;
  }
  synth(opts.preset, opts.volume);
}

export function playNotificationSound(): void {
  const s = getSettings();
  if (!s.notificationSoundEnabled) return;
  previewSound({
    preset: s.notificationSoundPreset,
    customPath: s.notificationSoundCustomPath,
    volume: s.notificationSoundVolume,
  });
}
