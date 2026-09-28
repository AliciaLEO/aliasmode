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

export const FIREFOX_RUNTIME_VERSION = "152.0.4-beta.30";
const FIREFOX_RUNTIME_RELEASE = `aliasmode-runtime-${FIREFOX_RUNTIME_VERSION}-r3`;
const FIREFOX_RELEASE_BASE = `https://github.com/aliasmode/aliasmode-firefox/releases/download/${FIREFOX_RUNTIME_RELEASE}`;

export const FIREFOX_RUNTIME_BUILDS: readonly FirefoxRuntimeBuild[] = [
  {
    platform: "linux", arch: "x64", executablePath: "aliasmode",
    archiveSha256: "53d02da74587f73f8a92bd9ef27bb5505674c3c4f89bc0e20f59353e82b14dca",
    executableSha256: "961ac5edb9e8ae63c1f9e78908e9585ef7ed43650ca35d7cd55652a14cf5a7c3",
  },
  {
    platform: "darwin", arch: "arm64", executablePath: "AliasMode.app/Contents/MacOS/aliasmode",
    archiveSha256: "99718013a49f0aa5bd77dd3f27fbf884a671a708320f7b8a53334e0bb672971a",
    executableSha256: "4fd5aade6b44fccd7cb5ac3e40f59f2ddc505f6e46cea9c1e9d7aaa74107cc09",
  },
  {
    platform: "win32", arch: "x64", executablePath: "aliasmode.exe",
    archiveSha256: "afd8289e95517379b3ee4a4b2fbda429c2aa078e7a80eb0c2860e387e0f04964",
    executableSha256: "138e5d0d0af515eacc0417cef0505efce6e8f9d96eba3eed289200bfb78b00d8",
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
