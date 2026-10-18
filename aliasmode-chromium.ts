/**
 * Browser runtimes that are downloaded on first use instead of being bundled:
 * the opt-in Chromium 155 beta, and CloakBrowser for the macOS and Linux apps. Each is
 * pinned by archive and executable SHA-256 like the bundled CloakBrowser kernel.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CLOAKBROWSER_MACOS_VERSION, CLOAKBROWSER_VERSION, sha256File } from "./browser-install.ts";

export const ALIASMODE_CHROMIUM_VERSION = "155.0.8059.31";
// AliasMode's own build of the patch series. Its package includes Chromium's
// version manifest, which upstream's Windows archive omits. Each build gets its
// own directory, so a browser still running from an earlier build keeps its files.
// A new build changes only the release tag and the two SHA-256 values of its release.
const WINDOWS_RELEASE = "aliasmode.2";
const WINDOWS_BUILD = {
  root: `aliasmode-chromium-${ALIASMODE_CHROMIUM_VERSION}-windows-x64`,
  url: `https://github.com/aliasmode/aliasmode-chromium/releases/download/v${ALIASMODE_CHROMIUM_VERSION}-${WINDOWS_RELEASE}/aliasmode-chromium-${ALIASMODE_CHROMIUM_VERSION}-windows-x64.zip`,
  dir: `chromium-${ALIASMODE_CHROMIUM_VERSION}-${WINDOWS_RELEASE}`,
  archiveSha256: "7892833b6126b13314461eb77b231318acc001b0065b652138dd6ed69dcce9cd",
  executable: "chrome.exe",
  executableSha256: "3f2404d037ba019c9ae6ce70e532991e9e3d109c9fb00c82d3455a680e95872f",
  // From aliasmode.2, pages read and draw at --force-device-scale-factor, and
  // --aliasmode-window-label names the window without touching page titles.
  hostScale: true,
  windowLabel: true,
};
const MACOS_BUILD = {
  root: `apostate-${ALIASMODE_CHROMIUM_VERSION}-macos-arm64`,
  url: "https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-macos-arm64.zip",
  dir: `chromium-${ALIASMODE_CHROMIUM_VERSION}`,
  archiveSha256: "58176ba9b3e9cfd74029165bdf716c636e618af17a48bd905fe6d5f1552d901a",
  executable: "Chromium.app/Contents/MacOS/Chromium",
  executableSha256: "2dfa8b148e6d06598981c4a1e1bc0d7c2c7860d74401ad0d934d21a10c7916d7",
  hostScale: false,
  windowLabel: false,
};
const LINUX_BUILD = {
  root: `apostate-${ALIASMODE_CHROMIUM_VERSION}-linux-x64`,
  url: "https://github.com/heretic-tech/apostate/releases/download/v0.5.1/apostate-155.0.8059.31-linux-x64.tar.zst",
  dir: `chromium-${ALIASMODE_CHROMIUM_VERSION}`,
  archiveSha256: "351955271b7ba1aed314bf14c2d64f6bd59bfdcb5c4a1541c9c921c570ff97bb",
  executable: "chrome",
  executableSha256: "c0b906dc621cec05330aed9d3b09bbb7b655a9c8546e4c61d222705fabfde6d3",
  hostScale: false,
  windowLabel: false,
};
// Apple Silicon macOS and Linux get upstream's builds; every other host keeps the Windows pins.
function chromiumBuild(platform: NodeJS.Platform): typeof WINDOWS_BUILD {
  return platform === "darwin" ? MACOS_BUILD : platform === "linux" ? LINUX_BUILD : WINDOWS_BUILD;
}
const BUILD = chromiumBuild(process.platform);
export const ALIASMODE_CHROMIUM_ARCHIVE_URL = BUILD.url;
export const ALIASMODE_CHROMIUM_ARCHIVE_SHA256 = BUILD.archiveSha256;
export const ALIASMODE_CHROMIUM_EXECUTABLE_SHA256 = BUILD.executableSha256;
/** The pinned Windows build can draw pages at the display's own scale; an earlier build must get scale 1. */
export const ALIASMODE_CHROMIUM_HOST_SCALE = WINDOWS_BUILD.hostScale;
/** The pinned Windows build takes --aliasmode-window-label. */
export const ALIASMODE_CHROMIUM_WINDOW_LABEL = WINDOWS_BUILD.windowLabel;

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

function chromium155(platform: NodeJS.Platform): PinnedRuntime {
  const build = chromiumBuild(platform);
  return {
    label: "Chromium 155",
    dir: build.dir,
    url: build.url,
    archiveSha256: build.archiveSha256,
    archiveRoot: build.root,
    executable: build.executable,
    executableSha256: build.executableSha256,
  };
}

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

// The Linux app ships no CloakBrowser either; it downloads CloakBrowser's own Linux build on first use.
export const CLOAKBROWSER_LINUX_EXECUTABLE_SHA256 = "715722e8605ae3ce81523c1218aba1ec89425786ab33ceaf99f8a6cb5e70e6e8";
const CLOAKBROWSER_LINUX: PinnedRuntime = {
  label: "CloakBrowser",
  dir: `cloakbrowser-${CLOAKBROWSER_VERSION}`,
  url: `https://github.com/CloakHQ/CloakBrowser/releases/download/chromium-v${CLOAKBROWSER_VERSION}/cloakbrowser-linux-x64.tar.gz`,
  archiveSha256: "4a12bcde95fa1bb1beef2b41ab5e5c27c36be78e3be3d0dac8c64d705216670e",
  archiveRoot: "",
  executable: "chrome",
  executableSha256: CLOAKBROWSER_LINUX_EXECUTABLE_SHA256,
};

/** The computers that can run Chromium 155. */
export function supportsChromium155Host(platform: NodeJS.Platform, arch: string): boolean {
  return (platform === "win32" && arch === "x64") || (platform === "darwin" && arch === "arm64")
    || (platform === "linux" && arch === "x64");
}

/** The AppArmor profile that the Linux install command adds for the downloaded Chrome runtimes. */
export const LINUX_CHROMIUM_APPARMOR_PROFILE = "/etc/apparmor.d/aliasmode-chromium";

/**
 * Ubuntu 23.10 and later let a program create the user namespace of Chrome's sandbox only when
 * an AppArmor profile allows it. These Chrome builds have no setuid sandbox helper to fall back on.
 */
export function linuxChromiumSandboxBlocked(
  read: (path: string) => string = (path) => readFileSync(path, "utf8"),
  exists: (path: string) => boolean = existsSync,
): boolean {
  try {
    if (read("/proc/sys/kernel/apparmor_restrict_unprivileged_userns").trim() !== "1") return false;
  } catch {
    return false;
  }
  return !exists(LINUX_CHROMIUM_APPARMOR_PROFILE);
}

/** New Chromium profiles made on macOS use this runtime, unless a CloakBrowser binary is configured. */
export function hostChromiumRuntime(platform = process.platform, env = process.env): "aliasmode" | undefined {
  return platform === "darwin" && !env.CLOAKBROWSER_BINARY_PATH ? "aliasmode" : undefined;
}

/**
 * The primary display's scale, which the desktop app passes in ALIASMODE_HOST_SCALE
 * (1.25 at 125%). 1 when it is missing or is not a display scale.
 */
export function hostDisplayScale(env: NodeJS.ProcessEnv = process.env): number {
  const scale = Number(env.ALIASMODE_HOST_SCALE);
  return Number.isFinite(scale) && scale >= 1 ? scale : 1;
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
export async function renameWhenUnlocked(from: string, to: string): Promise<void> {
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

export function aliasmodeChromiumExecutable(root: string, platform = process.platform): string {
  const build = chromiumBuild(platform);
  return join(root, build.dir, build.executable);
}

/** The pinned 155 archive of one system. */
export function aliasmodeChromiumArchive(platform: NodeJS.Platform): { url: string; archiveSha256: string; executableSha256: string } {
  const { url, archiveSha256, executableSha256 } = chromiumBuild(platform);
  return { url, archiveSha256, executableSha256 };
}

// ditto and tar keep the symlinks and code signature of a macOS app bundle.
function extractCommand(url: string, file: string, directory: string, platform: NodeJS.Platform): string[] {
  if (url.endsWith(".tar.gz")) return ["tar", "-xzf", file, "-C", directory];
  if (url.endsWith(".tar.zst")) return ["tar", "--zstd", "-xf", file, "-C", directory];
  return platform === "darwin" ? ["ditto", "-x", "-k", file, directory] : ["tar.exe", "-xf", file, "-C", directory];
}

async function install(spec: PinnedRuntime, root: string, deps: AliasmodeChromiumDeps, platform: NodeJS.Platform): Promise<string> {
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
  try {
    await (deps.download ?? ((url, output) => run([
      platform === "win32" ? "curl.exe" : "curl", "--fail", "--location", "--silent", "--show-error", "--retry", "2", "--retry-all-errors", "--output", output, url,
    ])))(spec.url, archive);
    if (await hashFile(archive) !== spec.archiveSha256) {
      throw new Error(`${spec.label} archive did not match its pinned SHA-256`);
    }
    await (deps.extract ?? ((file, directory) => run(extractCommand(spec.url, file, directory, platform))))(archive, extracted);
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
function ensure(spec: PinnedRuntime, root: string, deps: AliasmodeChromiumDeps, platform: NodeJS.Platform): Promise<string> {
  const key = `${root}\0${spec.dir}`;
  let pending = installing.get(key);
  if (!pending) {
    pending = install(spec, root, deps, platform).finally(() => installing.delete(key));
    installing.set(key, pending);
  }
  return pending;
}

/** Install the pinned Chromium 155 runtime and return its executable. */
export function ensureAliasmodeChromium(root: string, deps: AliasmodeChromiumDeps = {}, platform = process.platform): Promise<string> {
  return ensure(chromium155(platform), root, deps, platform);
}

/** Install the pinned CloakBrowser build for Apple Silicon macOS and return its executable. */
export function ensureCloakBrowserMacos(root: string, deps: AliasmodeChromiumDeps = {}): Promise<string> {
  return ensure(CLOAKBROWSER_MACOS, root, deps, "darwin");
}

/** Install the pinned CloakBrowser build for Linux x64 and return its executable. */
export function ensureCloakBrowserLinux(root: string, deps: AliasmodeChromiumDeps = {}): Promise<string> {
  return ensure(CLOAKBROWSER_LINUX, root, deps, "linux");
}
