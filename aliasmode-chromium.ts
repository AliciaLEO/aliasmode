/**
 * The opt-in Chromium 155 beta runtime. It is downloaded on first use instead
 * of being bundled, then pinned by archive and executable SHA-256 like the
 * bundled CloakBrowser kernel.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256File } from "./browser-install.ts";

export const ALIASMODE_CHROMIUM_VERSION = "155.0.8059.31";
export const ALIASMODE_CHROMIUM_ARCHIVE_URL =
  "https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-windows-x64.zip";
export const ALIASMODE_CHROMIUM_ARCHIVE_SHA256 = "8e55e44fb7f58619461e1d42a947446dcc08a2b46493c420c8e62ae27ab9c7e5";
export const ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 = "5b4e065110a8a24bb35448d2716d26427a91618b0ee1f4b33723c4d25722de67";
const ARCHIVE_ROOT = `apostate-${ALIASMODE_CHROMIUM_VERSION}-windows-x64`;
const RUNTIME_DIR = `chromium-${ALIASMODE_CHROMIUM_VERSION}`;
const TEMP_PREFIX = `.${RUNTIME_DIR}-`;

// The upstream archive omits Chromium's version assembly manifest, and Windows
// then refuses to start chrome.exe (error 14001). These are Chromium's own bytes.
const VERSION_MANIFEST = "<assembly\r\n  xmlns='urn:schemas-microsoft-com:asm.v1' manifestVersion='1.0'>\r\n" +
  `  <assemblyIdentity\r\n      name='${ALIASMODE_CHROMIUM_VERSION}'\r\n      version='${ALIASMODE_CHROMIUM_VERSION}'\r\n` +
  "      type='win32'/>\r\n  <file name='chrome_elf.dll'/>\r\n</assembly>\r\n";

export interface AliasmodeChromiumDeps {
  download?: (url: string, output: string) => Promise<void>;
  extract?: (archive: string, directory: string) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

export function aliasmodeChromiumExecutable(root: string): string {
  return join(root, RUNTIME_DIR, "chrome.exe");
}

async function install(root: string, deps: AliasmodeChromiumDeps): Promise<string> {
  const hashFile = deps.hashFile ?? sha256File;
  const target = join(root, RUNTIME_DIR);
  const executable = join(target, "chrome.exe");
  if (existsSync(join(target, `${ALIASMODE_CHROMIUM_VERSION}.manifest`)) && existsSync(executable) &&
    await hashFile(executable) === ALIASMODE_CHROMIUM_EXECUTABLE_SHA256) {
    return executable;
  }

  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(TEMP_PREFIX)) rmSync(join(root, entry), { recursive: true, force: true });
  }
  const temp = join(root, `${TEMP_PREFIX}${process.pid}-${Date.now()}`);
  const archive = join(temp, "runtime.zip");
  const extracted = join(temp, "extracted");
  mkdirSync(extracted, { recursive: true });
  try {
    await (deps.download ?? ((url, output) => run([
      "curl.exe", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--retry-all-errors", "--output", output, url,
    ])))(ALIASMODE_CHROMIUM_ARCHIVE_URL, archive);
    if (await hashFile(archive) !== ALIASMODE_CHROMIUM_ARCHIVE_SHA256) {
      throw new Error("Chromium 155 archive did not match its pinned SHA-256");
    }
    await (deps.extract ?? ((file, directory) => run(["tar.exe", "-xf", file, "-C", directory])))(archive, extracted);
    const runtime = join(extracted, ARCHIVE_ROOT);
    if (await hashFile(join(runtime, "chrome.exe")) !== ALIASMODE_CHROMIUM_EXECUTABLE_SHA256) {
      throw new Error("Chromium 155 archive contained an unexpected chrome.exe");
    }
    writeFileSync(join(runtime, `${ALIASMODE_CHROMIUM_VERSION}.manifest`), VERSION_MANIFEST);
    rmSync(target, { recursive: true, force: true });
    renameSync(runtime, target);
    return executable;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

let installing: Promise<string> | undefined;

/** Install the pinned runtime once per process and return its chrome.exe. */
export function ensureAliasmodeChromium(root: string, deps: AliasmodeChromiumDeps = {}): Promise<string> {
  installing ??= install(root, deps).finally(() => {
    installing = undefined;
  });
  return installing;
}
