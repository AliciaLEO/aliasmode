import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  aliasmodeChromiumArchive,
  aliasmodeChromiumExecutable,
  CLOAKBROWSER_LINUX_EXECUTABLE_SHA256,
  CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
  ensureAliasmodeChromium,
  ensureCloakBrowserLinux,
  ensureCloakBrowserMacos,
  hostChromiumRuntime,
  hostDisplayScale,
  LINUX_CHROMIUM_APPARMOR_PROFILE,
  linuxChromiumSandboxBlocked,
  supportsChromium155Host,
  type AliasmodeChromiumDeps,
} from "./aliasmode-chromium.ts";

const WINDOWS_155 = aliasmodeChromiumArchive("win32");
import { buildNewProfile } from "./create.ts";
import { parseExport, serializeAdsTxt, serializeXlsxRows } from "./parse.ts";
import { decodePortableProfile, encodePortableProfile } from "./portable-profile.ts";
import { ProfileStore } from "./store.ts";

/** Fake archive whose files carry their pinned hashes by content. */
function fakeRelease(options: { archiveHash?: string; executableHash?: string } = {}) {
  const downloads: string[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, options.archiveHash ?? WINDOWS_155.archiveSha256);
    },
    extract: async (_archive, directory) => {
      const root = join(directory, "aliasmode-chromium-155.0.8059.31-windows-x64");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "chrome.exe"), options.executableHash ?? WINDOWS_155.executableSha256);
      writeFileSync(join(root, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  return { deps, downloads };
}

test("installs AliasMode's own 155 build once, beside any earlier runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  mkdirSync(join(root, ".chromium-155.0.8059.31-aliasmode.2-stale"));
  // Earlier runtimes stay put for browsers still running from them.
  mkdirSync(join(root, "chromium-155.0.8059.31"));
  mkdirSync(join(root, "chromium-155.0.8059.31-aliasmode.1"));
  const release = fakeRelease();

  const executable = await ensureAliasmodeChromium(root, release.deps, "win32");
  expect(executable).toBe(aliasmodeChromiumExecutable(root, "win32"));
  expect(release.downloads).toEqual([WINDOWS_155.url]);
  expect(WINDOWS_155.url).toBe(
    "https://github.com/aliasmode/aliasmode-chromium/releases/download/v155.0.8059.31-aliasmode.2/aliasmode-chromium-155.0.8059.31-windows-x64.zip",
  );
  expect(executable).toBe(join(root, "chromium-155.0.8059.31-aliasmode.2", "chrome.exe"));
  expect(readdirSync(root).sort()).toEqual([
    "chromium-155.0.8059.31", "chromium-155.0.8059.31-aliasmode.1", "chromium-155.0.8059.31-aliasmode.2",
  ]);

  expect(await ensureAliasmodeChromium(root, release.deps, "win32")).toBe(executable);
  expect(release.downloads).toHaveLength(1);
});

test("Linux x64 installs upstream's 155 build from its zstd tar archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  const linux = aliasmodeChromiumArchive("linux");
  const downloads: string[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, linux.archiveSha256);
    },
    extract: async (_archive, directory) => {
      const runtime = join(directory, "apostate-155.0.8059.31-linux-x64");
      mkdirSync(runtime, { recursive: true });
      writeFileSync(join(runtime, "chrome"), linux.executableSha256);
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  expect(supportsChromium155Host("linux", "x64")).toBe(true);
  expect(supportsChromium155Host("linux", "arm64")).toBe(false);
  const executable = await ensureAliasmodeChromium(root, deps, "linux");
  expect(executable).toBe(join(root, "chromium-155.0.8059.31", "chrome"));
  expect(executable).toBe(aliasmodeChromiumExecutable(root, "linux"));
  expect(downloads).toEqual(["https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-linux-x64.tar.zst"]);
  expect(readdirSync(root)).toEqual(["chromium-155.0.8059.31"]);
});

test("rejects an archive or executable that does not match its pin", async () => {
  for (const options of [{ archiveHash: "0".repeat(64) }, { executableHash: "1".repeat(64) }]) {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
    await expect(ensureAliasmodeChromium(root, fakeRelease(options).deps, "win32")).rejects.toThrow("Chromium 155");
    expect(existsSync(aliasmodeChromiumExecutable(root, "win32"))).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  }
});

test("new profiles keep their Chromium runtime fixed locally and in Cloud payloads", () => {
  const store = new ProfileStore(":memory:");
  const beta = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const standard = buildNewProfile({}, () => false);
  expect(standard.chromiumRuntime).toBeUndefined();
  expect(() => buildNewProfile({ engine: "firefox", chromiumRuntime: "aliasmode" }, () => false)).toThrow();
  expect(() => buildNewProfile({ chromiumRuntime: "chrome-200" }, () => false)).toThrow("unsupported Chromium runtime");

  store.upsertProfile(beta);
  store.upsertProfile(standard);
  const { chromiumRuntime: _runtime, ...edited } = store.getProfile(beta.id)!;
  store.upsertProfile({ ...edited, name: "renamed" });
  expect(store.getProfile(beta.id)).toMatchObject({ name: "renamed", chromiumRuntime: "aliasmode" });
  const { hardware: _stored, ...standardEdit } = store.getProfile(standard.id)!;
  expect(() => store.upsertProfile({ ...standardEdit, chromiumRuntime: "aliasmode" }))
    .toThrow("Chromium runtime cannot change in place");
  expect(store.getProfile(standard.id)!.chromiumRuntime).toBeUndefined();

  // Cloud carries the runtime in schema V3, which older clients reject
  // instead of opening it on CloakBrowser. Default profiles stay V1.
  const payload = encodePortableProfile(beta);
  expect(payload.schemaVersion).toBe(3);
  expect(payload.profile).toMatchObject({ chromiumRuntime: "aliasmode" });
  expect(decodePortableProfile(payload).profile.chromiumRuntime).toBe("aliasmode");
  // A profile without stored hardware (made before it existed) stays V1.
  const { hardware: _hardware, ...legacy } = standard;
  const standardPayload = encodePortableProfile(legacy);
  expect(standardPayload.schemaVersion).toBe(1);
  expect("chromiumRuntime" in standardPayload.profile).toBe(false);
  expect(decodePortableProfile(standardPayload).profile.chromiumRuntime).toBeUndefined();
  expect(() => decodePortableProfile({ ...standardPayload, profile: { ...standardPayload.profile, chromiumRuntime: "aliasmode" } } as any))
    .toThrow("unsupported portable profile payload");
  expect(() => decodePortableProfile({ ...standardPayload, schemaVersion: 3 } as any)).toThrow("unsupported portable profile payload");
  store.close();
});

test("exports keep the Chrome version so a re-import cannot downgrade it", () => {
  const beta = buildNewProfile({ chromiumRuntime: "aliasmode" }, () => false);
  const standard = buildNewProfile({}, () => false);
  const text = serializeAdsTxt([beta, standard]);
  expect(text.match(/^chromium_runtime=aliasmode$/gm)).toHaveLength(1);
  const imported = parseExport(text).profiles;
  expect(imported.find((profile) => profile.id === beta.id)?.chromiumRuntime).toBe("aliasmode");
  expect(imported.find((profile) => profile.id === standard.id)?.chromiumRuntime).toBeUndefined();
  expect(serializeXlsxRows([beta, standard]).headers).toContain("chromium_runtime");
  expect(serializeXlsxRows([standard]).headers).not.toContain("chromium_runtime");
});

test("macOS uses the 155 runtime for Chromium profiles unless a CloakBrowser binary is configured", () => {
  expect(hostChromiumRuntime("darwin", {})).toBe("aliasmode");
  expect(hostChromiumRuntime("darwin", { CLOAKBROWSER_BINARY_PATH: "/opt/cloakbrowser" })).toBeUndefined();
  expect(hostChromiumRuntime("win32", {})).toBeUndefined();
  expect(hostChromiumRuntime("linux", {})).toBeUndefined();
});

test("the host display scale comes from the desktop app, and 1 stands in for a missing or invalid value", () => {
  expect(hostDisplayScale({ ALIASMODE_HOST_SCALE: "1.25" })).toBe(1.25);
  expect(hostDisplayScale({ ALIASMODE_HOST_SCALE: "2" })).toBe(2);
  for (const value of [undefined, "", "abc", "0", "0.5", "-1.5", "Infinity"]) {
    expect(hostDisplayScale({ ALIASMODE_HOST_SCALE: value })).toBe(1);
  }
});

test("installs the pinned CloakBrowser build for macOS from its tar archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const downloads: string[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, "505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c");
    },
    extract: async (_archive, directory) => {
      const bundle = join(directory, "Chromium.app", "Contents", "MacOS");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "Chromium"), CLOAKBROWSER_MACOS_EXECUTABLE_SHA256);
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  const executable = await ensureCloakBrowserMacos(root, deps);
  expect(executable).toBe(join(root, "cloakbrowser-145.0.7632.109.2", "Chromium.app", "Contents", "MacOS", "Chromium"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v145.0.7632.109.2/cloakbrowser-darwin-arm64.tar.gz",
  ]);
  expect(await ensureCloakBrowserMacos(root, deps)).toBe(executable);
  expect(downloads).toHaveLength(1);
  expect(readdirSync(root)).toEqual(["cloakbrowser-145.0.7632.109.2"]);
});

test("installs the pinned CloakBrowser build for Linux from its tar archive root", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-cloakbrowser-"));
  const downloads: string[] = [];
  const deps: AliasmodeChromiumDeps = {
    download: async (url, output) => {
      downloads.push(url);
      writeFileSync(output, "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e");
    },
    extract: async (_archive, directory) => writeFileSync(join(directory, "chrome"), CLOAKBROWSER_LINUX_EXECUTABLE_SHA256),
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  const executable = await ensureCloakBrowserLinux(root, deps);
  expect(executable).toBe(join(root, "cloakbrowser-146.0.7680.177.5", "chrome"));
  expect(downloads).toEqual([
    "https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz",
  ]);
  expect(await ensureCloakBrowserLinux(root, deps)).toBe(executable);
  expect(downloads).toHaveLength(1);
});

test("Linux blocks the Chrome sandbox only when AppArmor restricts user namespaces and our profile is missing", () => {
  const sysctl = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
  const read = (value: string) => (path: string) => {
    if (path !== sysctl) throw new Error(`unexpected read ${path}`);
    return value;
  };
  const missing = () => { throw new Error("no such file"); };
  expect(linuxChromiumSandboxBlocked(read("1\n"), () => false)).toBe(true);
  expect(linuxChromiumSandboxBlocked(read("1\n"), (path) => path === LINUX_CHROMIUM_APPARMOR_PROFILE)).toBe(false);
  expect(linuxChromiumSandboxBlocked(read("0\n"), () => false)).toBe(false);
  expect(linuxChromiumSandboxBlocked(missing, () => false)).toBe(false);
});
