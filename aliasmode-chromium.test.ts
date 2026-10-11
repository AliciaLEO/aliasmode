import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALIASMODE_CHROMIUM_ARCHIVE_SHA256,
  ALIASMODE_CHROMIUM_ARCHIVE_URL,
  ALIASMODE_CHROMIUM_EXECUTABLE_SHA256,
  aliasmodeChromiumExecutable,
  ensureAliasmodeChromium,
  type AliasmodeChromiumDeps,
} from "./aliasmode-chromium.ts";
import { buildNewProfile } from "./create.ts";
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
      const root = join(directory, "apostate-155.0.8059.31-windows-x64");
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, "chrome.exe"), options.executableHash ?? ALIASMODE_CHROMIUM_EXECUTABLE_SHA256);
      writeFileSync(join(root, "chrome.dll"), "dll");
    },
    hashFile: async (path) => readFileSync(path, "utf8"),
  };
  return { deps, downloads };
}

test("installs the pinned 155 runtime once and adds Chromium's version manifest", async () => {
  const root = mkdtempSync(join(tmpdir(), "aliasmode-chromium-"));
  mkdirSync(join(root, ".chromium-155.0.8059.31-stale"));
  const release = fakeRelease();

  const executable = await ensureAliasmodeChromium(root, release.deps);
  expect(executable).toBe(aliasmodeChromiumExecutable(root));
  expect(release.downloads).toEqual([ALIASMODE_CHROMIUM_ARCHIVE_URL]);
  const manifest = readFileSync(join(root, "chromium-155.0.8059.31", "155.0.8059.31.manifest"));
  // The exact bytes verified to start Chromium 155 on Windows.
  expect(createHash("sha256").update(manifest).digest("hex"))
    .toBe("dfc0444aa477681e88b3ea34867d58673b6894ac12980f435c67c0ee9673b5ab");
  expect(readdirSync(root)).toEqual(["chromium-155.0.8059.31"]);

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
  expect(() => store.upsertProfile({ ...store.getProfile(standard.id)!, chromiumRuntime: "aliasmode" }))
    .toThrow("Chromium runtime cannot change in place");
  expect(store.getProfile(standard.id)!.chromiumRuntime).toBeUndefined();

  // Cloud carries the runtime in schema V3, which older clients reject
  // instead of opening it on CloakBrowser. Default profiles stay V1.
  const payload = encodePortableProfile(beta);
  expect(payload.schemaVersion).toBe(3);
  expect(payload.profile).toMatchObject({ chromiumRuntime: "aliasmode" });
  expect(decodePortableProfile(payload).profile.chromiumRuntime).toBe("aliasmode");
  const standardPayload = encodePortableProfile(standard);
  expect(standardPayload.schemaVersion).toBe(1);
  expect("chromiumRuntime" in standardPayload.profile).toBe(false);
  expect(decodePortableProfile(standardPayload).profile.chromiumRuntime).toBeUndefined();
  expect(() => decodePortableProfile({ ...standardPayload, profile: { ...standardPayload.profile, chromiumRuntime: "aliasmode" } } as any))
    .toThrow("unsupported portable profile payload");
  expect(() => decodePortableProfile({ ...standardPayload, schemaVersion: 3 } as any)).toThrow("unsupported portable profile payload");
  store.close();
});
