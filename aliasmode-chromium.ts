/**
 * Browser runtimes that are downloaded on first use instead of being bundled:
 * the opt-in Chromium 155 beta, and CloakBrowser for the macOS app. Each is
 * pinned by archive and executable SHA-256 like the bundled CloakBrowser kernel.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLOAKBROWSER_MACOS_VERSION, sha256File } from "./browser-install.ts";

export const ALIASMODE_CHROMIUM_VERSION = "155.0.8059.31";
// AliasMode's own build of the patch series. Its package includes Chromium's
// version manifest, which upstream's Windows archive omits. Each build gets its
// own directory, so a browser still running from an earlier build keeps its files.
const WINDOWS_BUILD = {
  root: `aliasmode-chromium-${ALIASMODE_CHROMIUM_VERSION}-windows-x64`,
  url: "https://github.com/aliasmode/aliasmode-chromium/releases/download/v155.0.8059.31-aliasmode.1/aliasmode-chromium-155.0.8059.31-windows-x64.zip",
  dir: `chromium-${ALIASMODE_CHROMIUM_VERSION}-aliasmode.1`,
  archiveSha256: "8d103e7d1c2322df88af0581b19e71857288584123b16467bbf42a2ce17e5d28",
  executable: "chrome.exe",
  executableSha256: "3f2404d037ba019c9ae6ce70e532991e9e3d109c9fb00c82d3455a680e95872f",
};
const MACOS_BUILD = {
  root: `apostate-${ALIASMODE_CHROMIUM_VERSION}-macos-arm64`,
  url: "https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-macos-arm64.zip",
  dir: `chromium-${ALIASMODE_CHROMIUM_VERSION}`,
  archiveSha256: "58176ba9b3e9cfd74029165bdf716c636e618af17a48bd905fe6d5f1552d901a",
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: "2dfa8b148e6d06598981c4a1e1bc0d7c2c7860d74401ad0d934d21a10c7916d7",
};
// Apple Silicon macOS gets upstream's signed build; every other host keeps the Windows pins.
const BUILD = process.platform === "darwin" ? MACOS_BUILD : WINDOWS_BUILD;
const ARCHIVE_ROOT = BUILD.root;
export const ALIASMODE_CHROMIUM_ARCHIVE_URL = BUILD.url;
export const ALIASMODE_CHROMIUM_ARCHIVE_SHA256 = BUILD.archiveSha256;
export const ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 = BUILD.executableSha256;

/** One downloadable, hash-pinned browser runtime under the runtimes root. */
interface PinnedRuntime {
  label: string;
  dir: string;
  url: string;
  archiveSha256: string;
  /** Directory inside the archive that holds the runtime; empty when the archive root is the runtime. */
  archiveRoot: string;
  executable: string;
  executableSha256: string;
}

const CHROMIUM_155: PinnedRuntime = {
  label: "Chromium 155",
  dir: BUILD.dir,
  url: BUILD.url,
  archiveSha256: BUILD.archiveSha256,
  archiveRoot: ARCHIVE_ROOT,
  executable: BUILD.executable,
  executableSha256: BUILD.executableSha256,
};

// CloakBrowser publishes no macOS build after 145, so that build opens CloakBrowser profiles on a Mac.
export const CLOAKBROWSER_MACOS_EXECUTABLE_SHA256 = "79ddf7e7a7be8087319390ed79266387f6499b8a2e45ccfbaa724d7e7fff6b79";
const CLOAKBROWSER_MACOS: PinnedRuntime = {
  label: "CloakBrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_MACOS_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_MACOS_VERSION}/cloakbrowser-darwin-arm64.tar.gz`,
  archiveSha256: "505582aa1bd3971c577f70e0cbbe016431702bdb693529abfd943b5bd9120c1c",
  archiveRoot: "",
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: CLOAKBROWSER_MACOS_EXECUTABLE_SHA256,
};

/** New Chromium profiles made on macOS use this runtime, unless a CloakBrowser binary is configured. */
export function hostChromiumRuntime(platform = process.platform, env = process.env): "aliasmode" | undefined {
  return platform === "darwin" && !env.CLOAKBROWSER_BINARY_PATH ? "aliasmode" : undefined;
}

export interface AliasmodeChromiumDeps {
  download?: (url: string, output: string) => Promise<void>;
  extract?: (archive: string, directory: string) => Promise<void>;
  hashFile?: (path: string) => Promise<string>;
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "ignore" });
  if (await child.exited !== 0) throw new Error(`${command[0]} exited with code ${child.exitCode}`);
}

// Antivirus can briefly hold freshly extracted files open, so Windows refuses the rename.
async function renameWhenUnlocked(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(code)) throw error;
      await Bun.sleep(500);
    }
  }
}

export function aliasmodeChromiumExecutable(root: string): string {
  return join(root, BUILD.dir, BUILD.executable);
}

async function install(spec: PinnedRuntime, root: string, deps: AliasmodeChromiumDeps): Promise<string> {
  const hashFile = deps.hashFile ?? sha256File;
  const target = join(root, spec.dir);
  const executable = join(target, spec.executable);
  if (existsSync(executable) && await hashFile(executable) === spec.executableSha256) {
    return executable;
  }

  mkdirSync(root, { recursive: true });
  const tempPrefix = `.${spec.dir}-`;
  for (const entry of readdirSync(root)) {
    if (entry.startsWith(tempPrefix)) rmSync(join(root, entry), { recursive: true, force: true });
  }
  const temp = join(root, `${tempPrefix}${process.pid}-${Date.now()}`);
  const archive = join(temp, "runtime.archive");
  const extracted = join(temp, "extracted");
  mkdirSync(extracted, { recursive: true });
  const mac = process.platform === "darwin";
  try {
    await (deps.download ?? ((url, output) => run([
      mac ? "curl" : "curl.exe", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--retry-all-errors", "--output", output, url,
    ])))(spec.url, archive);
    if (await hashFile(archive) !== spec.archiveSha256) {
      throw new Error(`${spec.label} archive did not match its pinned SHA-256`);
    }
    // ditto and tar keep the symlinks and code signature of a macOS app bundle.
    await (deps.extract ?? ((file, directory) => run(spec.url.endsWith(".tar.gz")
      ? ["tar", "-xzf", file, "-C", directory]
      : mac ? ["ditto", "-x", "-k", file, directory] : ["tar.exe", "-xf", file, "-C", directory])))(archive, extracted);
    const runtime = spec.archiveRoot ? join(extracted, spec.archiveRoot) : extracted;
    if (await hashFile(join(runtime, spec.executable)) !== spec.executableSha256) {
      throw new Error(`${spec.label} archive contained an unexpected executable`);
    }
    rmSync(target, { recursive: true, force: true });
    await renameWhenUnlocked(runtime, target);
    return executable;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const installing = new Map<string, Promise<string>>();

/** Install a pinned runtime once at a time and return its executable. */
function ensure(spec: PinnedRuntime, root: string, deps: AliasmodeChromiumDeps): Promise<string> {
  const key = `${root}\0${spec.dir}`;
  let pending = installing.get(key);
  if (!pending) {
    pending = install(spec, root, deps).finally(() => installing.delete(key));
    installing.set(key, pending);
  }
  return pending;
}

/** Install the pinned Chromium 155 runtime and return its executable. */
export function ensureAliasmodeChromium(root: string, deps: AliasmodeChromiumDeps = {}): Promise<string> {
  return ensure(CHROMIUM_155, root, deps);
}

/** Install the pinned CloakBrowser build for Apple Silicon macOS and return its executable. */
export function ensureCloakBrowserMacos(root: string, deps: AliasmodeChromiumDeps = {}): Promise<string> {
  return ensure(CLOAKBROWSER_MACOS, root, deps);
}
