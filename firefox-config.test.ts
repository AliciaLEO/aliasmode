import { expect, test } from "bun:test";
import { completeProfileFingerprint, createFirefoxProfileConfig, firefoxLaunchConfig, firefoxStartupPrefs, fitFirefoxWindow } from "./firefox-config.ts";
import { encodePortableProfile, decodePortableProfile } from "./portable-profile.ts";
import type { FirefoxProfileConfig, JsonValue, Profile } from "./types.ts";

function profile(fingerprintSeed: number, config: Record<string, JsonValue> = {}, runtimeVersion = "156.0.1-beta.36"): Profile {
  return {
    id: `firefox-${fingerprintSeed}`, accId: "", name: "", group: "", username: "", password: "", twofa: "",
    proxy: null, ua: "", timezone: "", screenWidth: 1920, screenHeight: 1080, fingerprintSeed,
    cookies: [], seeded: false, engine: "firefox",
    firefox: { version: 1, runtimeVersion, config: { "navigator.platform": "Win32", ...config } },
  };
}

const isUint = (value: JsonValue | undefined) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffff_ffff;
const isStrings = (value: JsonValue | undefined) => Array.isArray(value) && value.every((item) => typeof item === "string");

/** The engine crashes on a value of the wrong type (settings/properties.json of the 156 engine). */
function expectEngineTypes(config: Record<string, JsonValue>) {
  expect(isUint(config["audio:seed"])).toBe(true);
  expect(config["voices:blockIfNotDefined"]).toBeBoolean();
  expect(config["mediaDevices:enabled"]).toBeBoolean();
  for (const kind of ["micros", "webcams", "speakers"]) expect(isUint(config[`mediaDevices:${kind}`])).toBe(true);
  for (const [count, list] of [["micros", "microphone"], ["webcams", "webcam"], ["speakers", "speaker"]]) {
    for (const suffix of ["Labels", "Groups"]) {
      const values = config[`mediaDevices:${list}${suffix}`];
      expect(isStrings(values)).toBe(true);
      expect((values as string[]).length).toBe(config[`mediaDevices:${count}`] as number);
    }
  }
  expect(Array.isArray(config.voices)).toBe(true);
  for (const voice of config.voices as Record<string, JsonValue>[]) {
    expect(Object.keys(voice).sort()).toEqual(["isDefault", "isLocalService", "lang", "name", "voiceUri"]);
    for (const key of ["lang", "name", "voiceUri"]) expect(voice[key]).toBeString();
    for (const key of ["isDefault", "isLocalService"]) expect(voice[key]).toBeBoolean();
  }
}

test("each Firefox launch gets an audio seed, voices and media devices from its profile seed, never stored", () => {
  const one = profile(3983315515, { "navigator.globalPrivacyControl": true, "canvas:seed": 7, "fonts:spacing_seed": 8 });
  const saved = structuredClone(one.firefox);
  const first = firefoxLaunchConfig(one);
  expectEngineTypes(first);
  expect((first.voices as JsonValue[]).length).toBeGreaterThan(0);
  expect(first["voices:blockIfNotDefined"]).toBe(true);
  expect(first["mediaDevices:enabled"]).toBe(true);
  // 156 ignores the canvas and font seeds; privacy control without its Sec-GPC header is a tell.
  for (const key of ["canvas:seed", "fonts:spacing_seed", "navigator.globalPrivacyControl", "aliasmode:windowLabel"]) {
    expect(first).not.toHaveProperty(key);
  }
  expect(firefoxLaunchConfig(structuredClone(one))).toEqual(first);
  expect(one.firefox).toEqual(saved);
  expect(firefoxLaunchConfig(profile(2354318635))["audio:seed"]).not.toBe(first["audio:seed"]);
});

test("a Firefox launch keeps a seed, voice list or media device set that the profile stores", () => {
  const config = firefoxLaunchConfig(profile(7, { "audio:seed": 42, voices: [], "voices:blockIfNotDefined": false, "mediaDevices:enabled": false }));
  expect(config).toMatchObject({ "audio:seed": 42, voices: [], "voices:blockIfNotDefined": false, "mediaDevices:enabled": false });
  expect(Object.keys(config).filter((key) => key.startsWith("mediaDevices:"))).toEqual(["mediaDevices:enabled"]);
});

test.each([
  ["Win32", "de-DE", /^urn:moz-tts:sapi:Microsoft [A-Za-z]+ - German \(Germany\)\?de-DE$/],
  ["MacIntel", "en-US", /^urn:moz-tts:osx:com\.apple\./],
  ["Linux x86_64", "en-US", /^urn:moz-tts:speechd:[^ ]+\?[a-z]/],
] as const)("Firefox voices and media devices follow the %s persona and %s locale", (platform, locale, uri) => {
  const config = firefoxLaunchConfig({ ...profile(11, { "navigator.platform": platform, "navigator.language": locale }), locale });
  expectEngineTypes(config);
  const voices = config.voices as Array<{ voiceUri: string; isDefault: boolean }>;
  expect(voices.some((voice) => uri.test(voice.voiceUri))).toBe(true);
  expect(voices.every((voice) => !voice.isDefault)).toBe(true);
  if (platform === "Linux x86_64") expect(config["mediaDevices:microphoneLabels"]).toContainEqual(expect.stringMatching(/^Monitor of /));
});

test("a proxied Firefox launch shows the proxy exit IP as WebRTC's public address in its own family", () => {
  const proxy = { type: "http" as const, host: "gate.example.net", port: "8080", user: "", pass: "" };
  const proxied = { ...profile(9, { "webrtc:ipv4": "198.51.100.1" }), proxy };
  const v4 = firefoxLaunchConfig(proxied, undefined, undefined, "203.0.113.7");
  expect(v4["webrtc:ipv4"]).toBe("203.0.113.7");
  expect(v4).not.toHaveProperty("webrtc:ipv6");
  const v6 = firefoxLaunchConfig({ ...profile(9), proxy }, undefined, undefined, "2001:db8::7");
  expect(v6["webrtc:ipv6"]).toBe("2001:db8::7");
  expect(v6).not.toHaveProperty("webrtc:ipv4");
  // Without an exit IP, or without a proxy, the launch config stays as before.
  expect(firefoxLaunchConfig({ ...profile(9), proxy })).not.toHaveProperty("webrtc:ipv4");
  expect(firefoxLaunchConfig(profile(9), undefined, undefined, "203.0.113.7")).not.toHaveProperty("webrtc:ipv4");
  expect(proxied.firefox!.config["webrtc:ipv4"]).toBe("198.51.100.1");
});

test("a Firefox launch shows the window label in the native title and starts in the profile's language", () => {
  const german = { ...profile(5, { "locale:language": "de", "locale:region": "DE", "navigator.language": "de-DE" }), locale: "de-DE" };
  expect(firefoxLaunchConfig(german, "Shop · #3 — ")["aliasmode:windowLabel"]).toBe("Shop · #3 — ");
  expect(firefoxStartupPrefs(german)).toEqual({
    "intl.locale.requested": "de-DE", "gfx.blacklist.webgpu": 4, "browser.startup.couldRestoreSession.count": -1,
    "gfx.font_rendering.fallback.async": false,
  });
  expect(firefoxStartupPrefs(profile(5))["intl.locale.requested"]).toBe("en-US");
});

test("a Firefox launch names the font pack folder of this computer only, never a saved one", () => {
  const saved = profile(5, { "aliasmode:fontsDir": "C:\\Users\\old\\fonts" });
  expect(firefoxLaunchConfig(saved)).not.toHaveProperty("aliasmode:fontsDir");
  expect(firefoxLaunchConfig(saved, undefined, "/data/runtimes/firefox-fonts/macos-1/fonts")["aliasmode:fontsDir"])
    .toBe("/data/runtimes/firefox-fonts/macos-1/fonts");
});

test("a Firefox profile saved for engine 152 moves to 156 like a browser update, everywhere it is completed", () => {
  const ua = (version: string) => `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${version}) Gecko/20100101 Firefox/${version}`;
  const legacy: Profile = {
    ...profile(9, { "navigator.userAgent": ua("152.0"), "headers.User-Agent": ua("152.0"), "navigator.appVersion": "5.0 (Windows)", fonts: ["Arial"] }, "152.0.4-beta.30"),
    ua: ua("152.0"), locale: "en-US", timezone: "UTC",
  };
  const current = completeProfileFingerprint(legacy);
  expect(current.firefox!.runtimeVersion).toBe("156.0.1-beta.36");
  expect(current.ua).toBe(ua("156.0"));
  expect(current.firefox!.config).toMatchObject({ "navigator.userAgent": ua("156.0"), "headers.User-Agent": ua("156.0") });
  // Nothing else of the identity changes.
  const unchanged = completeProfileFingerprint({ ...legacy, firefox: { ...legacy.firefox!, runtimeVersion: "156.0.1-beta.36" } });
  expect({ ...current.firefox!.config, "navigator.userAgent": "", "headers.User-Agent": "" })
    .toEqual({ ...unchanged.firefox!.config, "navigator.userAgent": "", "headers.User-Agent": "" });
  expect({ ...current, ua: "", firefox: undefined }).toEqual({ ...unchanged, ua: "", firefox: undefined });
  expect(completeProfileFingerprint(current)).toEqual(current);
  // Cloud and export payloads carry the same shape with the new runtime.
  const payload = encodePortableProfile(completeProfileFingerprint(legacy) as Profile & { engine: "firefox"; firefox: FirefoxProfileConfig });
  expect(payload.schemaVersion).toBe(2);
  expect(Object.keys(payload.profile.firefox).sort()).toEqual(["config", "runtimeVersion", "version"]);
  expect(payload.profile.firefox.runtimeVersion).toBe("156.0.1-beta.36");
  expect(decodePortableProfile(payload).profile.firefox).toEqual(current.firefox);
  // A profile from a newer engine is left for the launcher to refuse.
  const newer = { ...legacy, firefox: { ...legacy.firefox!, runtimeVersion: "157.0-beta.1" } };
  expect(completeProfileFingerprint(newer).firefox!.runtimeVersion).toBe("157.0-beta.1");
  expect(completeProfileFingerprint(newer).ua).toBe(ua("152.0"));
});

test("an existing Firefox window never exceeds its available screen", () => {
  // Stored before the fix: a full-screen window taller than the taskbar-free area, placed above the screen.
  const tall = firefoxLaunchConfig(profile(1, {
    "screen.availLeft": 1920, "window.screenX": 1912, "window.screenY": -46,
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1032,
    "window.outerWidth": 1920, "window.outerHeight": 1080,
  }));
  expect(tall).toMatchObject({
    "screen.width": 1920, "screen.height": 1080, "screen.availHeight": 1032, "screen.availLeft": 1920,
    "window.outerWidth": 1920, "window.outerHeight": 1032,
  });
  // The 156 engine shows pages the real window position, so the stored one is not sent.
  expect(tall).not.toHaveProperty("window.screenX");
  expect(tall).not.toHaveProperty("window.screenY");
  // A wide screen keeps its stored size and window.
  const wide = firefoxLaunchConfig(profile(2, {
    "window.screenX": 3307, "window.screenY": 180,
    "screen.width": 5120, "screen.height": 1440, "screen.availWidth": 5120, "screen.availHeight": 1400,
    "window.outerWidth": 1920, "window.outerHeight": 1080,
  }));
  expect(wide).toMatchObject({ "screen.width": 5120, "screen.height": 1440, "window.outerWidth": 1920, "window.outerHeight": 1080 });
});

test("a Firefox window on a second monitor stays on that monitor's available area", () => {
  const monitor = {
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1040,
    "screen.availLeft": 2176, "screen.availTop": 40, "window.outerWidth": 1248, "window.outerHeight": 972,
  };
  const at = (screenX: number, screenY: number) => {
    const config: Record<string, JsonValue> = { ...monitor, "window.screenX": screenX, "window.screenY": screenY };
    fitFirefoxWindow(config);
    return [config["window.screenX"], config["window.screenY"]];
  };
  expect(at(2297, 60)).toEqual([2297, 60]);
  expect(at(3000, 200)).toEqual([2848, 108]);
  expect(at(100, 0)).toEqual([2176, 40]);
});

test("fitting a Firefox window keeps the browser frame between outer and inner sizes", () => {
  const config: Record<string, JsonValue> = {
    "screen.width": 1366, "screen.height": 768, "screen.availWidth": 1400, "screen.availHeight": 728,
    "window.outerWidth": 1400, "window.outerHeight": 800, "window.innerWidth": 1380, "window.innerHeight": 700,
  };
  fitFirefoxWindow(config);
  expect(config).toMatchObject({
    "screen.availWidth": 1366, "window.outerWidth": 1366, "window.innerWidth": 1346,
    "window.outerHeight": 728, "window.innerHeight": 628,
  });
});

test.each([
  ["windows", 1920, 1080], ["windows", 1536, 864], ["windows", 2560, 1440], ["macos", 1440, 900], ["linux", 1366, 768],
] as const)("a new %s Firefox profile uses the chosen %ix%i screen and a window inside it", (os, width, height) => {
  const config = createFirefoxProfileConfig(width, height, os, 99).config as Record<string, number>;
  expect([config["screen.width"], config["screen.height"]]).toEqual([width, height]);
  expect(config["screen.availWidth"]).toBeLessThanOrEqual(width);
  expect(config["screen.availHeight"]).toBeLessThanOrEqual(height);
  expect(config["screen.availWidth"]! < width || config["screen.availHeight"]! < height).toBe(true);
  expect(config["window.outerWidth"]).toBeLessThanOrEqual(config["screen.availWidth"]!);
  expect(config["window.outerHeight"]).toBeLessThanOrEqual(config["screen.availHeight"]!);
  const left = config["screen.availLeft"] ?? 0;
  const top = config["screen.availTop"] ?? 0;
  expect(config["window.screenX"]).toBeGreaterThanOrEqual(left);
  expect(config["window.screenY"]).toBeGreaterThanOrEqual(top);
  expect(config["window.screenX"]! + config["window.outerWidth"]!).toBeLessThanOrEqual(left + config["screen.availWidth"]!);
  expect(config["window.screenY"]! + config["window.outerHeight"]!).toBeLessThanOrEqual(top + config["screen.availHeight"]!);
});

test("a new Firefox profile always keeps a taskbar, also where the generator drew none", () => {
  // Every drawn Windows 2560x1440 sample reported avail == screen before upstream's taskbar fix.
  for (let seed = 1; seed <= 6; seed++) {
    const config = createFirefoxProfileConfig(2560, 1440, "windows", seed).config as Record<string, number>;
    expect(config["screen.availWidth"]! < 2560 || config["screen.availHeight"]! < 1440).toBe(true);
    expect(config["window.outerHeight"]).toBeLessThanOrEqual(config["screen.availHeight"]!);
  }
});
