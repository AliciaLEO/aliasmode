import { accessSync, constants, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { browserEnvText, sha256File } from "./browser-install.ts";

export interface FirefoxRuntimeBuild {
  platform: NodeJS.Platform;
  arch: string;
  executablePath: string;
  archiveSha256: string;
  executableSha256: string;
}

export const FIREFOX_RUNTIME_VERSION = "156.0.1-beta.36";
const FIREFOX_RUNTIME_RELEASE = `aliasmode-runtime-${FIREFOX_RUNTIME_VERSION}-r6`;
const FIREFOX_RELEASE_BASE = `https://github.com/aliasmode/aliasmode-firefox/releases/download/${FIREFOX_RUNTIME_RELEASE}`;

export const FIREFOX_RUNTIME_BUILDS: readonly FirefoxRuntimeBuild[] = [
  {
    platform: "linux", arch: "x64", executablePath: "aliasmode",
    archiveSha256: "1cd48dcbdd83c2cdba696d4de1804979a9e36e5a8301534c5739130150f09744",
    executableSha256: "d3a8cafbcfd2974cd36dfc7d76d3cafb28e76179fa141908db7f82a4f2a16902",
  },
  {
    platform: "darwin", arch: "arm64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "e99f4266a7da6986f555fb01d6299ef11762d110c1c3b23c821c53ca9aeacb67",
    executableSha256: "42347f10e5c7bca773225268e783bae7d155555d666750b48b3a8950feb9a913",
  },
  {
    platform: "win32", arch: "x64", executablePath: "aliasmode.exe",
    archiveSha256: "87e46d5b303cbcf45b01d50c2d6ecd679ec4367b2e3ea61e532e8728093b3edf",
    executableSha256: "a180c9eb0ec42d64c8b0dce169d5bb790a4008695c36189eb297735eb6b2363c",
  },
];

export function firefoxBuildForHost(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  builds = FIREFOX_RUNTIME_BUILDS,
): FirefoxRuntimeBuild {
  const build = builds.find((candidate) => candidate.platform === platform && candidate.arch === arch);
  if (!build) {
    const host = platform === "darwin" ? "macOS" : platform === "linux" ? "Linux" : platform;
    throw new Error(`No approved AliasMode Firefox archive is available for ${host} ${arch}`);
  }
  return build;
}

export function firefoxReleaseArchiveUrl(build: FirefoxRuntimeBuild): string {
  const name = build.platform === "linux" && build.arch === "x64"
    ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-lin.x86_64.zip`
    : build.platform === "darwin" && build.arch === "arm64"
      ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-mac.arm64.zip`
      : build.platform === "win32" && build.arch === "x64"
        ? `aliasmode-${FIREFOX_RUNTIME_VERSION}-win.x86_64.zip`
        : "";
  if (!name) throw new Error(`No approved AliasMode Firefox release archive is available for ${build.platform} ${build.arch}`);
  return `${FIREFOX_RELEASE_BASE}/${name}`;
}

async function downloadFirefoxArchive(
  build: FirefoxRuntimeBuild,
  cwd: string,
  fetcher: (input: string) => Promise<Response>,
): Promise<{ archive: string; cleanup: () => void }> {
  const directory = mkdtempSync(join(cwd, ".aliasmode-firefox-download-"));
  const archive = join(directory, firefoxReleaseArchiveUrl(build).split("/").at(-1)!);
  try {
    const response = await fetcher(firefoxReleaseArchiveUrl(build));
    if (!response.ok) throw new Error("approved AliasMode Firefox release download failed");
    // Bun 1.2.21 can leave Bun.write(Response) pending for streamed redirects.
    await pipeline(response.body as unknown as import("node:stream/web").ReadableStream, createWriteStream(archive));
    return { archive, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

async function extractFirefoxArchive(archive: string, destination: string, platform: NodeJS.Platform): Promise<void> {
  const command = platform === "darwin" ? ["ditto", "-x", "-k", archive, destination]
    : platform === "win32" ? ["tar.exe", "-xf", archive, "-C", destination]
      : ["unzip", "-q", archive, "-d", destination];
  if (!Bun.which(command[0]!)) throw new Error(`Firefox setup requires ${command[0]} on PATH`);
  const child = Bun.spawn(command, { stdout: "ignore", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error("AliasMode Firefox archive extraction failed");
}

export async function installFirefox(
  options: { archive?: string; cwd?: string; platform?: NodeJS.Platform; arch?: string; writeEnv?: boolean },
  dependencies: {
    builds?: readonly FirefoxRuntimeBuild[];
    extract?: (archive: string, destination: string, platform: NodeJS.Platform) => Promise<void>;
    fetch?: (input: string) => Promise<Response>;
  } = {},
): Promise<{ path: string; sha256: string }> {
  const platform = options.platform ?? process.platform;
  const build = firefoxBuildForHost(platform, options.arch ?? process.arch, dependencies.builds);
  const cwd = resolve(options.cwd ?? process.cwd());
  const downloaded = options.archive
    ? undefined
    : await downloadFirefoxArchive(build, cwd, dependencies.fetch ?? fetch);
  const archive = options.archive ? resolve(options.archive) : downloaded!.archive;
  try {
    if (await sha256File(archive) !== build.archiveSha256) {
      throw new Error("AliasMode Firefox archive does not match the approved host build SHA-256");
    }
    const cache = join(cwd, "browser");
    mkdirSync(cache, { recursive: true });
    // A new directory leaves any previously installed, running browser untouched.
    const root = mkdtempSync(join(cache, `firefox-${platform}-${build.arch}-`));
    try {
      await (dependencies.extract ?? extractFirefoxArchive)(archive, root, platform);
      const path = join(root, build.executablePath);
      const sha256 = await sha256File(path);
      if (sha256 !== build.executableSha256) throw new Error("AliasMode Firefox executable does not match its approved SHA-256");
      if (platform !== "win32") accessSync(path, constants.X_OK);
      if (options.writeEnv !== false) {
        const envPath = join(cwd, ".env");
        const current = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
        const newline = current.includes("\r\n") || platform === "win32" ? "\r\n" : "\n";
        writeFileSync(envPath, browserEnvText(current, path, sha256, newline, "ALIASMODE_FIREFOX"), "utf8");
      }
      return { path, sha256 };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  } finally {
    downloaded?.cleanup();
  }
}
