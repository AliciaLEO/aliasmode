// @ts-expect-error Bun embeds this package data in compiled sidecars.
import fingerprintNetworkDefinitionPath from "./node_modules/fingerprint-generator/data_files/fingerprint-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import inputNetworkDefinitionPath from "./node_modules/header-generator/data_files/input-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import headerNetworkDefinitionPath from "./node_modules/header-generator/data_files/header-network-definition.zip" with { type: "file" };
// @ts-expect-error Bun embeds this package data in compiled sidecars.
import webglDataPath from "./node_modules/camoufox-js/dist/data-files/webgl_data.db" with { type: "file" };
import { Database } from "bun:sqlite";
import { isIP } from "node:net";
import type { ChromiumRuntime, FirefoxProfileConfig, JsonValue, Profile, ProfileEngine } from "./types.ts";
import fonts from "camoufox-js/dist/mappings/fonts.config.js";
import { deterministicSeed, launchWindowSize, platformFromUA, seedFraction } from "./fingerprint.ts";
import { localeForTimezone, normalizeProfileLocale } from "./profile-locale.ts";
import { firefoxMediaDevices, firefoxVoices, type PersonaOs } from "./firefox-media.ts";

const generatorAssetInputs = [
  ["fingerprint-network-definition.zip", fingerprintNetworkDefinitionPath],
  ["input-network-definition.zip", inputNetworkDefinitionPath],
  ["header-network-definition.zip", headerNetworkDefinitionPath],
] as const;
const generatorAssets = Object.fromEntries(await Promise.all(generatorAssetInputs.map(async ([name, source]) => {
  return [name, Buffer.from(await Bun.file(source).arrayBuffer())] as const;
})));
(globalThis as typeof globalThis & { __aliasmodeGeneratorAssets?: Record<string, Buffer> }).__aliasmodeGeneratorAssets = generatorAssets;
const { fromBrowserforge, generateFingerprint } = await import("camoufox-js/dist/fingerprints.js");

interface GraphicsIdentity {
  weight: number;
  keys: Record<string, JsonValue>;
}

/**
 * Real graphics identities per system from the engine's data set, weighted by how
 * common they are. Each has the vendor, the renderer and the matching WebGL limits.
 * Software renderers are left out: they are no device identity.
 */
const graphicsIdentities = await (async (): Promise<Record<PersonaOs, GraphicsIdentity[]>> => {
  const database = Database.deserialize(new Uint8Array(await Bun.file(webglDataPath).arrayBuffer()));
  const rows = database
    .prepare("SELECT renderer, data, win, mac, lin FROM webgl_fingerprints ORDER BY vendor, renderer, data")
    .all() as Array<{ renderer: string; data: string; win: number; mac: number; lin: number }>;
  database.close();
  const forSystem = (column: "win" | "mac" | "lin") => rows.flatMap((row) => {
    const { webGl2Enabled, ...keys } = JSON.parse(row.data) as Record<string, JsonValue>;
    return row[column] > 0 && webGl2Enabled === true && !/SwiftShader|Basic Render/i.test(row.renderer)
      ? [{ weight: row[column], keys }]
      : [];
  });
  return { windows: forSystem("win"), macos: forSystem("mac"), linux: forSystem("lin") };
})();

/** Choose the graphics identity of a profile. The same seed always gives the same one. */
export function graphicsIdentity(platformOs: PersonaOs, seed: number): Record<string, JsonValue> {
  const options = graphicsIdentities[platformOs];
  const total = options.reduce((sum, option) => sum + option.weight, 0);
  let remaining = seedFraction(seed) * total;
  for (const option of options) {
    remaining -= option.weight;
    if (remaining < 0) return structuredClone(option.keys);
  }
  return structuredClone(options.at(-1)!.keys);
}

export const FIREFOX_RUNTIME_VERSION = "156.0.1-beta.36";
const FIREFOX_UA_MAJOR_VERSION = "156";

/**
 * Generate an OS-matched identity once, for durable profile storage. With a seed the
 * identity also has its own graphics card, so the profile shows the same hardware on
 * every computer instead of the graphics card of the computer that opens it.
 */
export function createFirefoxProfileConfig(
  screenWidth: number,
  screenHeight: number,
  platformOs: PersonaOs = "windows",
  seed?: number,
): FirefoxProfileConfig {
  // The chosen size is the screen. The window opens at the app's usual fraction of it.
  const windowSize = launchWindowSize(screenWidth, screenHeight);
  const options = { browsers: ["firefox" as const], operatingSystems: [platformOs] };
  let fingerprint;
  try {
    fingerprint = generateFingerprint(windowSize, {
      ...options,
      screen: { minWidth: screenWidth, maxWidth: screenWidth, minHeight: screenHeight, maxHeight: screenHeight },
    });
  } catch {
    // No Firefox sample has this screen size. The size is set below instead.
    fingerprint = generateFingerprint(windowSize, options);
  }
  const config = fromBrowserforge(fingerprint, FIREFOX_UA_MAJOR_VERSION);
  // The generator can also drop a screen it cannot match: keep its taskbar on the chosen size.
  for (const [axis, size] of [["width", screenWidth], ["height", screenHeight]] as const) {
    const avail = axis === "width" ? "screen.availWidth" : "screen.availHeight";
    const generated = config[`screen.${axis}`];
    if (typeof generated === "number" && typeof config[avail] === "number") {
      config[avail] = Math.max(1, size - Math.max(0, generated - config[avail]));
    }
    config[`screen.${axis}`] = size;
  }
  // Every desktop keeps a taskbar, dock or panel visible, so a screen without one is a headless
  // tell (CreepJS "noTaskbar"). Give it upstream's size (fix_screen_no_taskbar).
  if (config["screen.availWidth"] === screenWidth && config["screen.availHeight"] === screenHeight) {
    config["screen.availHeight"] = screenHeight - (platformOs === "windows" ? 40 : platformOs === "macos" ? 25 : 27);
  }
  fitFirefoxWindow(config);
  if (typeof config.timezone !== "string" || !config.timezone.trim()) {
    config.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
  if (seed !== undefined) Object.assign(config, graphicsIdentity(platformOs, seed));
  return normalizeFirefoxProfileConfig({
    version: 1,
    runtimeVersion: FIREFOX_RUNTIME_VERSION,
    config,
  });
}

/**
 * Keep inner <= outer <= available <= screen and the window inside the available area, as
 * upstream Camoufox does (clamp_window_dimensions/clamp_window_position). The engine sizes the
 * real window from these values, so a window larger than its own screen is an impossible geometry.
 */
export function fitFirefoxWindow(config: Record<string, JsonValue>): void {
  const value = (key: string) => typeof config[key] === "number" ? config[key] as number : undefined;
  for (const [axis, position] of [["Width", "window.screenX"], ["Height", "window.screenY"]] as const) {
    const screen = value(`screen.${axis.toLowerCase()}`);
    const avail = value(`screen.avail${axis}`);
    if (screen && avail && avail > screen) config[`screen.avail${axis}`] = screen;
    const cap = value(`screen.avail${axis}`) ?? screen;
    const outer = value(`window.outer${axis}`);
    const inner = value(`window.inner${axis}`);
    if (outer && cap && outer > cap) {
      config[`window.outer${axis}`] = cap;
      if (inner) config[`window.inner${axis}`] = Math.max(1, cap - Math.max(0, outer - inner));
    }
    const fittedOuter = value(`window.outer${axis}`);
    const fittedInner = value(`window.inner${axis}`);
    if (fittedInner && fittedOuter && fittedInner > fittedOuter) config[`window.inner${axis}`] = fittedOuter;
    // The position is page-visible only. It stays inside the available area of the window's own
    // screen, which a multi-monitor layout places at availLeft/availTop.
    const at = value(position);
    const origin = value(axis === "Width" ? "screen.availLeft" : "screen.availTop") ?? 0;
    if (at !== undefined && cap && fittedOuter) {
      config[position] = Math.max(origin, Math.min(at, origin + cap - fittedOuter));
    }
  }
}

/**
 * Keys the 156 engine ignores (canvas:seed, fonts:spacing_seed; window.screenX/Y, as pages see the
 * real window position) or that are a tell: navigator.globalPrivacyControl is true without the
 * Sec-GPC header stock Firefox sends with it.
 */
const DROPPED_LAUNCH_KEYS = [
  "canvas:seed", "fonts:spacing_seed", "window.screenX", "window.screenY", "navigator.globalPrivacyControl",
];

/**
 * The config one launch sends to the engine. Seeds, voices, media devices, the window label and
 * the window fit are derived here and never stored, so saved Local and Cloud profiles keep their
 * exact shape. A value the profile stores itself is kept.
 */
export function firefoxLaunchConfig(profile: Profile, windowLabel?: string, fontsDir?: string, webRtcIp?: string): Record<string, JsonValue> {
  const config = { ...profile.firefox!.config };
  for (const key of DROPPED_LAUNCH_KEYS) delete config[key];
  // The font pack of the profile's OS, when it is not this computer's OS (firefox-fonts.ts).
  if (fontsDir) config["aliasmode:fontsDir"] = fontsDir;
  else delete config["aliasmode:fontsDir"];
  const seed = (key: string) => deterministicSeed(`${profile.fingerprintSeed}:${key}`);
  // Without a seed every profile on one computer gives the same audio output.
  config["audio:seed"] ??= seed("audio:seed");
  // Without these, profiles on one computer read back the same canvas and WebGL pixels and
  // measure the same text widths.
  config["aliasmode:canvasSeed"] ??= seed("aliasmode:canvasSeed");
  config["aliasmode:textSeed"] ??= seed("aliasmode:textSeed");
  const os = firefoxPersonaOs(profile, config);
  // Without its own list the engine shows this computer's voices.
  config.voices ??= firefoxVoices(os, firefoxStartupLocale(profile), seed("voices"));
  config["voices:blockIfNotDefined"] ??= true;
  if (!Object.keys(config).some((key) => key.startsWith("mediaDevices:"))) {
    Object.assign(config, firefoxMediaDevices(os, seed("mediaDevices")));
  }
  // The engine shows the label in the native window title only, adding its own separator.
  if (windowLabel) config["aliasmode:windowLabel"] = windowLabel;
  // Behind a proxy the engine shows the proxy's exit IP as WebRTC's public address, as a browser
  // at that exit would, in place of no address. The current exit replaces any stored one.
  if (profile.proxy && webRtcIp) config[isIP(webRtcIp) === 6 ? "webrtc:ipv6" : "webrtc:ipv4"] = webRtcIp;
  fitFirefoxWindow(config);
  return config;
}

/** The profile's language for the browser interface, Intl and form messages (as upstream Camoufox sets it). */
function firefoxStartupLocale(profile: Profile): string {
  return configuredFirefoxLocale(profile.firefox!.config) ?? normalizeProfileLocale(profile.locale) ?? "en-US";
}

/**
 * Preferences the engine applies at startup (CAMOU_PREFS_n). Without intl.locale.requested the
 * 156 engine keeps an English interface and Intl locale whatever the profile's language. The
 * WebGPU block keeps the computer's real graphics card from showing through navigator.gpu. The
 * app restores sessions itself, so Firefox's "Open previous tabs?" bar stays off. When the
 * profile's font list hides the font the system picks for a character (CJK text with a Windows
 * font list on Linux), Firefox searches the listed fonts instead; asynchronous fallback skips
 * the ones whose character maps are still loading, so text measured in the first seconds after
 * startup differs from the same text measured later. Synchronous fallback gives one result.
 * The engine turns the new tab page off, so a new tab was blank; Firefox's own page (logo and a
 * search box that uses the default search engine) is local, makes no requests and adds nothing
 * a site can see.
 */
export function firefoxStartupPrefs(profile: Profile): Record<string, JsonValue> {
  return {
    "intl.locale.requested": firefoxStartupLocale(profile),
    "gfx.blacklist.webgpu": 4,
    "browser.startup.couldRestoreSession.count": -1,
    "gfx.font_rendering.fallback.async": false,
    "browser.newtabpage.enabled": true,
  };
}

export function firefoxPersonaOs(profile: Profile, config: Record<string, JsonValue> = profile.firefox?.config ?? {}): PersonaOs {
  const ua = typeof config["navigator.userAgent"] === "string" ? config["navigator.userAgent"] : "";
  const os = profile.platformOs || platformFromUA(profile.ua) || platformFromUA(ua);
  if (os === "windows" || os === "macos" || os === "linux") return os;
  return config["navigator.platform"] === "MacIntel" ? "macos"
    : String(config["navigator.platform"] ?? "").startsWith("Linux") ? "linux" : "windows";
}

/**
 * A profile saved for an older AliasMode Firefox moves to the current engine, as a normal browser
 * update would: the runtime and the Firefox version in its user agent change, nothing else.
 * A newer runtime is left alone, and the launcher then refuses it.
 */
function updateFirefoxRuntime(profile: Profile): Profile {
  const firefox = profile.firefox!;
  const major = Number.parseInt(firefox.runtimeVersion, 10);
  if (firefox.runtimeVersion === FIREFOX_RUNTIME_VERSION || !(major < Number(FIREFOX_UA_MAJOR_VERSION))) return profile;
  const update = (ua: string) => ua
    .replace(/\brv:\d+\.\d+/, `rv:${FIREFOX_UA_MAJOR_VERSION}.0`)
    .replace(/\bFirefox\/\d+\.\d+/, `Firefox/${FIREFOX_UA_MAJOR_VERSION}.0`);
  const config = { ...firefox.config };
  for (const key of ["navigator.userAgent", "headers.User-Agent"]) {
    if (typeof config[key] === "string") config[key] = update(config[key]);
  }
  return {
    ...profile,
    ua: update(profile.ua),
    firefox: { ...firefox, runtimeVersion: FIREFOX_RUNTIME_VERSION, config },
  };
}

function configuredFirefoxLocale(config: Record<string, JsonValue>): string | undefined {
  const language = config["locale:language"];
  const region = config["locale:region"];
  const explicit = config["locale:all"] || config["navigator.language"];
  const value = typeof explicit === "string" ? explicit.split(",")[0]?.trim()
    : typeof language === "string" ? [language, config["locale:script"], region].filter(Boolean).join("-")
    : undefined;
  return normalizeProfileLocale(value);
}

/** Complete missing identity only at creation or closed-profile persistence boundaries. */
export function completeProfileFingerprint(profile: Profile): Profile {
  const saved = profile.firefox?.config;
  const locale = normalizeProfileLocale(profile.locale)
    ?? (saved ? configuredFirefoxLocale(saved) : undefined)
    ?? localeForTimezone(profile.timezone);
  if (profile.engine !== "firefox" || !profile.firefox) return { ...profile, locale };

  profile = updateFirefoxRuntime(profile);
  const config = { ...profile.firefox!.config };
  const tag = new Intl.Locale(locale);
  const previousLocale = configuredFirefoxLocale(config);
  config["locale:language"] = tag.language;
  if (tag.region) config["locale:region"] = tag.region;
  else delete config["locale:region"];
  if (tag.script) config["locale:script"] = tag.script;
  else delete config["locale:script"];
  config["navigator.language"] = locale;
  if (!config["locale:all"] || previousLocale !== locale) {
    config["locale:all"] = [...new Set([locale, tag.language])].join(", ");
  }
  if (config["navigator.languages"] !== undefined && previousLocale !== locale) {
    config["navigator.languages"] = [...new Set([locale, tag.language])];
  }
  if (config.fonts === undefined) {
    const platform = firefoxPersonaOs(profile, config);
    config.fonts = [...fonts[platform === "macos" ? "mac" : platform === "linux" ? "lin" : "win"]];
  }
  return { ...profile, locale, firefox: { ...profile.firefox!, config } };
}

export function syncFirefoxTimezone(profile: Profile): void {
  if (profile.engine !== "firefox") return;
  if (!profile.firefox) throw new Error("Firefox profile is missing its saved configuration");
  const { timezone: _timezone, ...config } = profile.firefox.config;
  profile.firefox = {
    ...profile.firefox,
    config: { ...config, ...(profile.timezone ? { timezone: profile.timezone } : {}) },
  };
}

/** Normalize and validate the persisted Camoufox identity at every boundary. */
export function normalizeFirefoxProfileConfig(value: unknown): FirefoxProfileConfig {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "runtimeVersion", "config"])) {
    throw new Error("invalid Firefox profile config");
  }
  if (value.version !== 1) throw new Error("unsupported Firefox profile config version");
  if (typeof value.runtimeVersion !== "string" || !value.runtimeVersion.trim()) {
    throw new Error("Firefox profile config runtimeVersion must be a non-empty string");
  }
  if (!isRecord(value.config)) throw new Error("Firefox profile config must include a config object");
  return {
    version: 1,
    runtimeVersion: value.runtimeVersion.trim(),
    config: normalizeJsonRecord(value.config),
  };
}

/** Treat a missing legacy engine as Chromium and reject malformed combinations. */
export function normalizeProfileEngine(value: unknown, firefox: unknown): {
  engine: ProfileEngine;
  firefox?: FirefoxProfileConfig;
} {
  const engine = value === undefined ? "chromium" : value;
  if (engine !== "chromium" && engine !== "firefox") throw new Error("unsupported profile engine");
  if (engine === "firefox") {
    if (firefox === undefined) throw new Error("Firefox profiles require a Firefox config");
    return { engine, firefox: normalizeFirefoxProfileConfig(firefox) };
  }
  if (firefox !== undefined) throw new Error("Chromium profiles cannot include a Firefox config");
  return { engine };
}

/** Absent, empty, or "cloakbrowser" means the CloakBrowser runtime, which is stored as no runtime. */
export function normalizeChromiumRuntime(value: unknown, engine: ProfileEngine): ChromiumRuntime | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "aliasmode" && value !== "cloakbrowser") throw new Error("unsupported Chromium runtime");
  if (engine !== "chromium") throw new Error("only Chromium profiles can choose a Chromium runtime");
  return value === "aliasmode" ? value : undefined;
}

function normalizeJsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeJson(item)]));
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Firefox profile config must contain JSON values");
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) return normalizeJsonRecord(value);
  throw new Error("Firefox profile config must contain JSON values");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
