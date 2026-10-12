import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALIASMODE_CHROMIUM_ARCHIVE_SHA256,
  ALIASMODE_CHROMIUM_ARCHIVE_URL,
  ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
  aliasmodeChromiumExecutable,
  CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
  ensureAliasmodeChromium,
  ensureCloakBrowserMacos,
  hostChromiumRuntime,
  type AliasmodeChromiumDeps,
} from "./aliasmode-chromium.ts";
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
      writeFileSync(output, options.archiveHash ?? ALIASMODE_CHROMIUM_ARCHIVE_SHA256);
    },
    extract: async (_archive, directory) => {
      const root = join(directory, "aliasmode-chromium-155.0.8059.31-windows-x64");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "chrome.exe"), options.executableHash ?? ALIASMODE_CHROMIUM_EXECUTABLE_SHA256);
      writeFileSync(join(root, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  return { deps, downloads };
}

test("installs AliasMode's own 155 build once, beside any earlier runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  mkdirSync(join(root, ".chromium-155.0.8059.31-aliasmode.1-stale"));
  // The upstream runtime earlier betas installed stays put for browsers still running from it.
  mkdirSync(join(root, "chromium-155.0.8059.31"));
  const release = fakeRelease();

  const executable = await ensureAliasmodeChromium(root, release.deps);
  expect(executable).toBe(aliasmodeChromiumExecutable(root));
  expect(release.downloads).toEqual([ALIASMODE_CHROMIUM_ARCHIVE_URL]);
  expect(ALIASMODE_CHROMIUM_ARCHIVE_URL)
    .toStartWith("https://github.com/aliasmode/aliasmode-chromium/releases/download/");
  expect(readdirSync(root).sort()).toEqual(["chromium-155.0.8059.31", "chromium-155.0.8059.31-aliasmode.1"]);

  expect(await ensureAliasmodeChromium(root, release.deps)).toBe(executable);
  expect(release.downloads).toHaveLength(1);
});

test("rejects an archive or executable that does not match its pin", async () => {
  for (const options of [{ archiveHash: "0".repeat(64) }, { executableHash: "1".repeat(64) }]) {
    const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
    await expect(ensureAliasmodeChromium(root, fakeRelease(options).deps)).rejects.toThrow("Chromium 155");
    expect(existsSync(aliasmodeChromiumExecutable(root))).toBe(false);
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
