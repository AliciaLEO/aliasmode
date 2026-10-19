/**
 * Speech voices and media devices for an AliasMode Firefox profile. Without its own list the
 * engine shows this computer's voices, and a desktop with no media devices is a headless tell.
 * The models and data come from the Camoufox launcher (firefox-data/, MIT, see LICENSE there):
 * the voices a stock Windows, macOS or Linux desktop has for its display language, and the
 * sound cards, headsets, displays and cameras common on each system.
 */
import voiceManifests from "./firefox-data/voice-manifests.json";
import voiceUris from "./firefox-data/voice-uris.json";
import mediaCatalogue from "./firefox-data/media-devices.json";
import { seedFraction } from "./fingerprint.ts";
import type { JsonValue } from "./types.ts";

export type PersonaOs = "windows" | "macos" | "linux";
type OsKey = "win" | "mac" | "lin";
const OS_KEYS: Record<PersonaOs, OsKey> = { windows: "win", macos: "mac", linux: "lin" };

interface Size { n: number; w: number }
interface VoicePack { oneCore?: string[]; desktop?: string[]; desktopProb?: number; weight?: number }
interface VoiceManifest {
  base?: string[];
  langPacks?: Record<string, VoicePack>;
  fallbackLocale?: string;
  additions?: Array<{
    id?: string; kind: string; prob?: number; deferred?: boolean; requiresLocale?: string;
    voices?: string[]; groups?: string[]; sizes?: Size[];
  }>;
}
interface MediaItem { w?: number; mics?: string[]; outs?: string[]; cam?: string; mic?: string | null }
interface MediaSystem {
  cards: MediaItem[]; headsets: MediaItem[]; displays: MediaItem[]; cameras: MediaItem[];
  p_headset?: number; p_display?: number; p_extra_camera?: number; monitor_sources?: boolean;
}

/** A Mulberry32 stream: the same seed always gives the same draws. */
function draws(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    const value = seedFraction(state);
    state = (state + 0x6d2b79f5) >>> 0;
    return value;
  };
}

function pick<T>(random: () => number, items: readonly T[], weight: (item: T) => number): T {
  let remaining = random() * items.reduce((sum, item) => sum + weight(item), 0);
  for (const item of items) {
    remaining -= weight(item);
    if (remaining < 0) return item;
  }
  return items.at(-1)!;
}

function sample<T>(random: () => number, items: readonly T[], count: number, weight: (item: T) => number): T[] {
  const pool = [...items];
  const chosen: T[] = [];
  while (pool.length && chosen.length < count) {
    const item = pick(random, pool, weight);
    pool.splice(pool.indexOf(item), 1);
    chosen.push(item);
  }
  return chosen;
}

/** The voiceURI that stock Firefox reports for a voice on each system. */
function voiceUri(os: OsKey, name: string, lang: string): string {
  if (os === "win") return `urn:moz-tts:sapi:${name}?${lang}`;
  if (os === "lin") {
    const escaped = [...name].map((ch) => ch === " " ? "%20" : ch.charCodeAt(0) <= 0x7f ? ch : encodeURIComponent(ch)).join("");
    return `urn:moz-tts:speechd:${escaped}?${lang}`;
  }
  // Every base macOS voice has a captured identifier; the optional downloads are MacinTalk voices.
  return (voiceUris.mac as Record<string, string>)[`${name}|${lang}`]
    ?? `urn:moz-tts:osx:com.apple.speech.synthesis.voice.${name.replace(/[^A-Za-z0-9]/g, "")}`;
}

/**
 * Share of desktops with voices beyond the stock set: speech packs of a second language on
 * Windows, downloaded MacinTalk voices on macOS. The manifest's lower estimates left most
 * profiles on one computer with the same list; AliasMode Chromium's Windows voices use 62% too.
 */
const EXTRA_VOICE_SHARE = 0.62;
const EXTRA_VOICE_ADDITIONS = new Set(["extra-languages", "macintalk-download"]);

/** The speech voices of a desktop with this system and display language. No voice is the default, as in stock Firefox. */
export function firefoxVoices(os: PersonaOs, locale: string, seed: number): JsonValue[] {
  const random = draws(seed);
  const key = OS_KEYS[os];
  const manifest = (voiceManifests as Record<OsKey, VoiceManifest>)[key];
  const packs = manifest.langPacks ?? {};
  const entries: string[] = [];
  const legacy: string[] = [];
  const chosen = new Set<string>();
  const add = (list: string[] = []) => { for (const entry of list) if (!entries.includes(entry)) entries.push(entry); };
  const takePack = (name: string) => {
    const pack = packs[name]!;
    chosen.add(name);
    add(pack.oneCore);
    if (pack.desktop && random() < (pack.desktopProb ?? 0)) {
      for (const entry of pack.desktop) if (!legacy.includes(entry)) legacy.push(entry);
    }
  };
  add(manifest.base);
  const names = Object.keys(packs);
  if (names.length) {
    const language = locale.split("-")[0]!.toLowerCase();
    const fallback = manifest.fallbackLocale && packs[manifest.fallbackLocale] ? manifest.fallbackLocale : names[0]!;
    takePack(packs[locale] ? locale : names.find((name) => name.split("-")[0]!.toLowerCase() === language) ?? fallback);
  }
  for (const addition of manifest.additions ?? []) {
    if (addition.deferred) continue;
    if (addition.requiresLocale && !locale.toLowerCase().startsWith(addition.requiresLocale.toLowerCase())) continue;
    if (random() >= (EXTRA_VOICE_ADDITIONS.has(addition.id ?? "") ? Math.max(addition.prob ?? 0, EXTRA_VOICE_SHARE) : addition.prob ?? 0)) continue;
    const count = () => addition.sizes ? pick(random, addition.sizes, (size) => size.w).n : Number.POSITIVE_INFINITY;
    if (addition.kind === "bundle") add(addition.voices);
    else if (addition.kind === "alacarte") {
      for (const entry of sample(random, addition.voices ?? [], count(), () => 1)) {
        if (entries.includes(entry)) continue;
        // A downloaded voice sits in its alphabetical place.
        const at = entries.findIndex((existing) => existing.toLowerCase() > entry.toLowerCase());
        entries.splice(at < 0 ? entries.length : at, 0, entry);
      }
    } else if (addition.kind === "groups") {
      const eligible = (addition.groups ?? []).filter((group) => packs[group] && !chosen.has(group));
      if (!eligible.length) continue;
      for (const group of sample(random, eligible, count(), (name) => packs[name]!.weight || 0.01)) takePack(group);
    }
  }
  return [...entries, ...legacy].map((entry) => {
    // "Name:lang:type"; a name may itself contain a colon.
    const typeAt = entry.lastIndexOf(":");
    const langAt = entry.lastIndexOf(":", typeAt - 1);
    const name = entry.slice(0, langAt);
    const lang = entry.slice(langAt + 1, typeAt);
    return { name, lang, voiceUri: voiceUri(key, name, lang), isDefault: false, isLocalService: entry.slice(typeAt + 1) === "local" };
  });
}

// Share of machines with no microphone (a tower with a line-out only) and with a built-in camera.
const NO_MICROPHONE: Record<OsKey, number> = { win: 0.08, mac: 0, lin: 0.2 };
const BUILT_IN_CAMERA: Record<OsKey, number> = { win: 0.78, mac: 0, lin: 0.45 };

/**
 * One computer's microphones, cameras and speakers as mediaDevices:* keys. Devices of one piece
 * of hardware share a group, as their groupId does. The engine applies Firefox's own rules on
 * what a page sees before and after a permission grant.
 */
export function firefoxMediaDevices(os: PersonaOs, seed: number): Record<string, JsonValue> {
  const random = draws(seed);
  const key = OS_KEYS[os];
  const catalogue = (mediaCatalogue as unknown as Record<OsKey, MediaSystem>)[key];
  const weight = (item: MediaItem) => item.w ?? 1;
  const mics: Array<[string, string]> = [];
  const outs: Array<[string, string]> = [];
  const cams: Array<[string, string]> = [];
  let groups = 0;
  const group = () => `hw-${++groups}`;
  const add = (item: MediaItem, id: string) => {
    for (const mic of item.mics ?? []) mics.push([mic, id]);
    for (const out of item.outs ?? []) outs.push([out, id]);
    if (item.cam) cams.push([item.cam, group()]);
  };
  // The computer's own sound card, with a built-in camera on some macOS models.
  const card = pick(random, catalogue.cards, weight);
  const noMicrophone = random() < NO_MICROPHONE[key];
  add(noMicrophone ? { ...card, mics: [] } : card, group());
  // A built-in laptop camera, rare on a tower without a microphone.
  if (random() < (noMicrophone ? BUILT_IN_CAMERA[key] * 0.3 : BUILT_IN_CAMERA[key])) {
    const builtIn = catalogue.cameras.filter((camera) => !camera.mic);
    if (builtIn.length) cams.push([pick(random, builtIn, weight).cam!, group()]);
  }
  if (random() < (catalogue.p_headset ?? 0)) add(pick(random, catalogue.headsets, weight), group());
  if (random() < (catalogue.p_display ?? 0)) add(pick(random, catalogue.displays, weight), group());
  // An external webcam, usually with its own microphone.
  if (random() < (catalogue.p_extra_camera ?? 0)) {
    const withMic = catalogue.cameras.filter((camera) => camera.mic);
    const camera = pick(random, withMic.length ? withMic : catalogue.cameras, weight);
    const id = group();
    cams.push([camera.cam!, id]);
    if (camera.mic) mics.push([camera.mic, id]);
  }
  // PulseAudio lists a monitor source of every output as a microphone.
  if (catalogue.monitor_sources) for (const [label, id] of [...outs]) mics.push([`Monitor of ${label}`, id]);
  return {
    "mediaDevices:enabled": true,
    "mediaDevices:micros": mics.length,
    "mediaDevices:webcams": cams.length,
    "mediaDevices:speakers": outs.length,
    "mediaDevices:microphoneLabels": mics.map(([label]) => label),
    "mediaDevices:microphoneGroups": mics.map(([, id]) => id),
    "mediaDevices:webcamLabels": cams.map(([label]) => label),
    "mediaDevices:webcamGroups": cams.map(([, id]) => id),
    "mediaDevices:speakerLabels": outs.map(([label]) => label),
    "mediaDevices:speakerGroups": outs.map(([, id]) => id),
  };
}
