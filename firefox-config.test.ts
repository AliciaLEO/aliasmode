import { expect, test } from "bun:test";
import {
  completeProfileFingerprint, createFirefoxProfileConfig, firefoxGraphicsRenderer, firefoxLaunchConfig, firefoxStartupPrefs, fitFirefoxWindow, graphicsIdentity,
} from "./firefox-config.ts";
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
  for (const key of ["audio:seed", "aliasmode:canvasSeed", "aliasmode:textSeed"]) expect(isUint(config[key])).toBe(true);
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

test("each Firefox launch gets audio, canvas and text seeds, voices and media devices from its profile seed, never stored", () => {
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
  const other = firefoxLaunchConfig(profile(2354318635));
  for (const key of ["audio:seed", "aliasmode:canvasSeed", "aliasmode:textSeed"]) expect(other[key]).not.toBe(first[key]);
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
  // Stock Firefox marks the system voice of the display language as the default on macOS only.
  expect(voices.filter((voice) => voice.isDefault).map((voice) => voice.voiceUri))
    .toEqual(platform === "MacIntel" ? ["urn:moz-tts:osx:com.apple.voice.compact.en-US.Samantha"] : []);
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
    "intl.locale.requested": "de-DE", "dom.webgpu.enabled": true, "gfx.blacklist.webgpu": 4, "browser.startup.couldRestoreSession.count": -1,
    "gfx.font_rendering.fallback.async": false,
    "browser.newtabpage.enabled": true,
  });
  expect(firefoxStartupPrefs(profile(5))["intl.locale.requested"]).toBe("en-US");
});

test("WebGPU shows where stock Firefox 156 has it, with this computer's adapter only for a macOS profile on an Apple Silicon Mac", () => {
  const macos = (config: Record<string, JsonValue> = {}) => ({ ...profile(5, { "navigator.platform": "MacIntel", ...config }), platformOs: "macos" as const });
  const webgpu = (persona: Profile, platform?: NodeJS.Platform, arch?: string) => {
    const prefs = firefoxStartupPrefs(persona, platform, arch);
    return [prefs["dom.webgpu.enabled"], prefs["gfx.blacklist.webgpu"] === 4];
  };
  const intelCard = { "webGl:vendor": "Intel Inc.", "webGl:renderer": "Intel(R) HD Graphics 400, or similar" };
  // On an Apple Silicon Mac a macOS profile claims that Mac's card family: its adapter is shown.
  expect(webgpu(macos(), "darwin", "arm64")).toEqual([true, false]);
  expect(webgpu(macos(intelCard), "darwin", "arm64")).toEqual([true, false]);
  // Elsewhere an Apple profile has navigator.gpu without an adapter; without a stored card it shows the computer's.
  expect(webgpu(macos(graphicsIdentity("macos", 1)), "win32", "x64")).toEqual([true, true]);
  expect(webgpu(macos(intelCard), "linux", "x64")).toEqual([true, true]);
  expect(webgpu(macos(), "win32", "x64")).toEqual([false, true]);
  expect(webgpu(macos(), "darwin", "x64")).toEqual([false, true]);
  // Windows always has navigator.gpu, and the app does not know the computer's card; Linux has none.
  for (const [platform, arch] of [["win32", "x64"], ["darwin", "arm64"], [undefined, undefined]] as const) {
    expect(webgpu(profile(5), platform, arch)).toEqual([true, true]);
    expect(webgpu(profile(5, { "navigator.platform": "Linux x86_64" }), platform, arch)).toEqual([false, true]);
  }
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
    "screen.width": 1920, "screen.height": 1080, "screen.availHeight": 1032, "screen.availLeft": 0,
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
  // Stock Firefox's baseline protection shows the whole screen on Linux, less a taskbar or menu bar elsewhere.
  expect(config["screen.availHeight"]! < height).toBe(os !== "linux");
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

test("a Firefox launch shows its own subset of the stock font list, the same on every launch", () => {
  const stocked = (seed: number, platform: string) => completeProfileFingerprint(profile(seed, { "navigator.platform": platform }));
  const core: Record<string, string[]> = {
    Win32: ["Arial", "Times New Roman", "Segoe UI", "Calibri", "Tahoma", "Verdana", "Courier New", "Microsoft YaHei", "SimSun",
      "Segoe Fluent Icons", "Ink Free", "Bahnschrift", "Gadugi", "Myanmar Text", "Javanese Text", "HoloLens MDL2 Assets"],
    MacIntel: ["Helvetica", "Helvetica Neue", "Geneva", "Luminari", "Galvji", "STIX Two Math", "Noto Sans Gunjala Gondi", "Noto Serif Yezidi"],
    "Linux x86_64": ["Arimo", "Tinos", "Cousine", "Noto Sans SC", "Noto Serif Yezidi", "Twemoji Mozilla"],
  };
  for (const [platform, kept] of Object.entries(core)) {
    const stock = stocked(1, platform).firefox!.config.fonts as string[];
    const lists = Array.from({ length: 12 }, (_, i) => firefoxLaunchConfig(stocked(i + 1, platform)).fonts as string[]);
    expect(new Set(lists.map((list) => list.join("|"))).size).toBeGreaterThan(3);
    expect(lists.some((list) => list.length < stock.length)).toBe(true);
    for (const list of lists) {
      for (const font of kept) expect(list).toContain(font);
      expect(list.every((font) => stock.includes(font))).toBe(true);
    }
    expect(firefoxLaunchConfig(stocked(1, platform)).fonts).toEqual(lists[0]!);
  }
  // The stored list is unchanged, and a list the user changed is shown as stored.
  const one = stocked(5, "Win32");
  const saved = structuredClone(one.firefox!.config.fonts);
  firefoxLaunchConfig(one);
  expect(one.firefox!.config.fonts).toEqual(saved);
  expect(firefoxLaunchConfig(profile(5, { fonts: ["Arial", "Gabriola"] })).fonts).toEqual(["Arial", "Gabriola"]);
});

test("most Firefox profiles list voices beyond the stock set, each the same on every launch", () => {
  for (const platform of ["Win32", "MacIntel"]) {
    const counts = Array.from({ length: 200 }, (_, i) => (firefoxLaunchConfig(profile(i + 1, { "navigator.platform": platform })).voices as JsonValue[]).length);
    const stock = Math.min(...counts);
    const share = counts.filter((count) => count > stock).length / counts.length;
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.75);
  }
  expect(firefoxLaunchConfig(profile(9)).voices).toEqual(firefoxLaunchConfig(profile(9)).voices!);
});

test("a macOS profile shows Apple graphics only, with the texture limits stock Firefox reports on a Mac", () => {
  for (let seed = 1; seed <= 500; seed++) {
    const keys = graphicsIdentity("macos", seed);
    expect(keys).toMatchObject({ "webGl:vendor": "Apple", "webGl:renderer": "Apple M1, or similar" });
    // GLContext.cpp limits textures and renderbuffers to 8192 on every Mac; the viewport stays 16384.
    for (const block of ["webGl:parameters", "webGl2:parameters"]) {
      expect(keys[block]).toMatchObject({ 3379: 8192, 34024: 8192, 34076: 8192, 3386: [16384, 16384] });
    }
  }
  // A macOS profile stored with an Intel Mac's or a Windows Direct3D card opens with Apple's; the stored one stays.
  const apple = graphicsIdentity("macos", 1);
  const intel = { "webGl:vendor": "Intel Inc.", "webGl:renderer": "Intel(R) HD Graphics 400, or similar", "webGl:parameters": { 3379: 16384 } };
  for (const card of [graphicsIdentity("windows", 7), intel]) {
    const stored = profile(8, { "navigator.platform": "MacIntel", ...card });
    const saved = structuredClone(stored.firefox);
    expect(firefoxLaunchConfig(stored)).toMatchObject(apple);
    expect(firefoxGraphicsRenderer(stored)).toBe("Apple M1, or similar");
    expect(stored.firefox).toEqual(saved);
  }
  // A Windows profile keeps its card, and a profile without a stored card gets none.
  const windows = profile(8, graphicsIdentity("windows", 7));
  expect(firefoxLaunchConfig(windows)).toMatchObject(graphicsIdentity("windows", 7));
  expect(firefoxGraphicsRenderer(windows)).toBe(graphicsIdentity("windows", 7)["webGl:renderer"]!);
  expect(firefoxLaunchConfig(profile(8, { "navigator.platform": "MacIntel" }))).not.toHaveProperty("webGl:vendor");
  expect(firefoxGraphicsRenderer(profile(8, { "navigator.platform": "MacIntel" }))).toBeUndefined();
});

/** The usable area stock Firefox 156 reports with its baseline protection (GetSpoofedScreenAvailSize). */
const baseline = { windows: [0, 48], macos: [25, 76], linux: [0, 0] } as const;

test.each([
  ["windows", 1920, 1080], ["windows", 1536, 864], ["macos", 1440, 900], ["macos", 1512, 982], ["linux", 1366, 768],
] as const)("new %s profiles at %ix%i show stock Firefox's usable area and no touch points", (os, width, height) => {
  // Each draw is a new generator sample; most Windows ones put the area beside the screen or have touch points.
  for (let seed = 1; seed <= 25; seed++) {
    const config = createFirefoxProfileConfig(width, height, os, seed).config as Record<string, number>;
    const [top, less] = baseline[os];
    expect(config).toMatchObject({
      "screen.availLeft": 0, "screen.availTop": top, "screen.availWidth": width, "screen.availHeight": height - less, "navigator.maxTouchPoints": 0,
    });
    // The window stays on its screen.
    expect(config["window.screenX"]! + config["window.outerWidth"]!).toBeLessThanOrEqual(width);
    expect(config["window.screenY"]).toBeGreaterThanOrEqual(top);
    expect(config["window.screenY"]! + config["window.outerHeight"]!).toBeLessThanOrEqual(height);
  }
});

test("an existing profile opens with stock Firefox's usable area and no touch points, its stored values unchanged", () => {
  const windows = profile(3, {
    "screen.width": 1920, "screen.height": 1080, "screen.availWidth": 1920, "screen.availHeight": 1040,
    "screen.availLeft": 1920, "screen.availTop": 40, "navigator.maxTouchPoints": 2,
    "window.outerWidth": 1248, "window.outerHeight": 1040,
  });
  const saved = structuredClone(windows.firefox);
  expect(firefoxLaunchConfig(windows)).toMatchObject({
    "screen.availLeft": 0, "screen.availTop": 0, "screen.availWidth": 1920, "screen.availHeight": 1032, "navigator.maxTouchPoints": 0,
    "window.outerHeight": 1032,
  });
  expect(windows.firefox).toEqual(saved);
  // Whatever a macOS profile stored, it opens with the menu bar and dock stock Firefox reports.
  const mac = (config: Record<string, JsonValue>) => firefoxLaunchConfig(profile(4, {
    "navigator.platform": "MacIntel", "screen.width": 1440, "screen.height": 900, "screen.availWidth": 1440, ...config,
  }));
  const storedAreas: Array<Record<string, JsonValue>> = [
    { "screen.availHeight": 744 }, { "screen.availWidth": 1380, "screen.availHeight": 900 }, { "screen.availTop": 33, "screen.availHeight": 860 },
  ];
  for (const stored of storedAreas) {
    expect(mac(stored)).toMatchObject({ "screen.availLeft": 0, "screen.availTop": 25, "screen.availWidth": 1440, "screen.availHeight": 824 });
  }
  const linux = firefoxLaunchConfig(profile(5, { "navigator.platform": "Linux x86_64", "screen.width": 1366, "screen.height": 768, "screen.availHeight": 741 }));
  expect(linux).toMatchObject({ "screen.availTop": 0, "screen.availHeight": 768 });
});

test("a macOS profile lists the voices stock Firefox shows there and marks one default, the system voice of its locale or else of its language", () => {
  const voices = (locale: string, seed: number, platform = "MacIntel") => firefoxLaunchConfig({ ...profile(seed, { "navigator.platform": platform }), locale })
    .voices as Array<{ name: string; lang: string; voiceUri: string; isDefault: boolean }>;
  const defaults = (locale: string, seed: number, platform = "MacIntel") =>
    voices(locale, seed, platform).filter((voice) => voice.isDefault).map((voice) => `${voice.name} ${voice.lang}`);
  for (let seed = 1; seed <= 100; seed++) {
    expect(defaults("en-US", seed)).toEqual(["Samantha en-US"]);
    expect(defaults("en-GB", seed)).toEqual(["Daniel en-GB"]);
    expect(defaults("de-DE", seed)).toEqual(["Anna de-DE"]);
    expect(defaults("en-US", seed, "Win32")).toEqual([]);
    // OSXSpeechSynthesizerService.mm leaves out the Eloquence and novelty voices.
    const list = voices("en-US", seed);
    for (const voice of list) {
      expect(voice.voiceUri).not.toContain("com.apple.eloquence");
      expect(["Albert", "Bad News", "Bells", "Trinoids", "Whisper", "Wobble", "Zarvox"]).not.toContain(voice.name);
    }
    // In speechVoices order, as stock Firefox 156 on macOS 15 lists them: by language, then identifier.
    const keys = list.map((voice) => `${voice.lang} ${voice.voiceUri}`);
    expect(keys).toEqual([...keys].sort());
    expect(list.slice(0, 5).map((voice) => `${voice.name} ${voice.lang}`))
      .toEqual(["Majed ar-001", "Daria bg-BG", "Montse ca-ES", "Zuzana cs-CZ", "Sara da-DK"]);
  }
  // A downloaded voice sits with its language, by identifier: Alex before Samantha in en-US.
  const english = Array.from({ length: 50 }, (_, i) => voices("en-US", i + 1).filter((voice) => voice.lang === "en-US").map((voice) => voice.name))
    .find((names) => names.includes("Alex"))!;
  expect(english.indexOf("Alex")).toBeLessThan(english.indexOf("Samantha"));
  for (const [locale, voice] of [
    ["fr-CA", "Amélie fr-CA"], ["en-CA", "Samantha en-US"], ["es-AR", "Mónica es-ES"], ["de-AT", "Anna de-DE"],
    ["zh-Hant-TW", "Meijia zh-TW"], ["ar-SA", "Majed ar-001"], ["ja-JP", "Kyoko ja-JP"],
  ] as const) {
    expect(defaults(locale, 1)).toEqual([voice]);
  }
  // macOS has no Lithuanian voice, so it gives none for that language.
  expect(defaults("lt-LT", 1)).toEqual([]);
});
