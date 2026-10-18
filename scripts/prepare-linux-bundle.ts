/** Stages the Linux x64 bundle inputs: sidecar, AliasMode Firefox and the agent runtime. */
import { cpSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FIREFOX_RUNTIME_VERSION, firefoxBuildForHost, installFirefox } from "../firefox-install.ts";
import { installSourceNode } from "../source-runtime.ts";
import { ALIASMODE_VERSION } from "../version.ts";
import { installPython } from "./prepare-macos-bundle.ts";
import { compileSidecar, stageAgentRuntime } from "./prepare-windows-bundle.ts";

const BUN_TARGET = "bun-linux-x64-baseline";
const RUST_TARGET = "x86_64-unknown-linux-gnu";

// The same CPython and Playwright versions as the other bundles, in their Linux x64 builds.
const PYTHON = {
  archive: {
    url: "https://github.com/astral-sh/python-build-standalone/releases/download/20250918/cpython-3.13.7%2B20250918-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz",
    sha256: "888fb7e192caafdb33e028f865b7da68dce5e924cfe58fcef96323e175a70e3e",
  },
  wheels: [
    {
      url: "https://files.pythonhosted.org/packages/f1/af/009958cbf23fac551a940d34e3206e6c7eed2b8c940d0c3afd1feb0b0589/playwright-1.58.0-py3-none-manylinux1_x86_64.whl",
      sha256: "c95568ba1eda83812598c1dc9be60b4406dffd60b149bc1536180ad108723d6b",
    },
    {
      url: "https://files.pythonhosted.org/packages/d9/42/b87bc2a81e3a62c3de2b0d550bf91a86939442b7ff85abb94eec3fc0e6aa/greenlet-3.1.1-cp313-cp313-manylinux_2_17_x86_64.manylinux2014_x86_64.whl",
      sha256: "efc0f674aa41b92da8c49e0346318c6075d734994c3c4e4430b1c3f853e498e4",
    },
    {
      url: "https://files.pythonhosted.org/packages/9b/4d/b9add7c84060d4c1906abe9a7e5359f2a60f7a9a4f67268b2766673427d8/pyee-13.0.0-py3-none-any.whl",
      sha256: "48195a3cddb3b1515ce0695ed76036b5ccc2ef3a9f963ff9f77aec0139845498",
    },
    {
      url: "https://files.pythonhosted.org/packages/18/67/36e9267722cc04a6b9f15c7f3441c2363321a3ea07da7ae0c0707beb2a9c/typing_extensions-4.15.0-py3-none-any.whl",
      sha256: "f0fa19c6845758ab08074a0cfa8b7aecb71c999ca73d62883bc25cc018c4e548",
    },
  ],
};

export async function prepareLinuxBundle(cwd = process.cwd()): Promise<void> {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error("Linux bundle preparation requires Linux x64");
  }
  const tauri = join(resolve(cwd), "src-tauri");
  const staging = join(tauri, "target", "desktop-staging");
  const firefoxRoot = join(tauri, "resources", "firefox");
  const playwrightRoot = join(tauri, "resources", "playwright");
  for (const path of [staging, firefoxRoot, playwrightRoot]) rmSync(path, { recursive: true, force: true });
  for (const path of [staging, join(tauri, "generated"), join(tauri, "binaries"), join(playwrightRoot, "node")]) {
    mkdirSync(path, { recursive: true });
  }

  await compileSidecar(cwd, join(tauri, "binaries", `aliasmode-sidecar-${RUST_TARGET}`), BUN_TARGET);

  const build = firefoxBuildForHost();
  const firefox = await installFirefox({ cwd: staging, writeEnv: false });
  renameSync(resolve(firefox.path, ...build.executablePath.split("/").map(() => "..")), firefoxRoot);

  cpSync(await installSourceNode(staging), join(playwrightRoot, "node", "node"));
  await installPython(staging, playwrightRoot, PYTHON);
  stageAgentRuntime(cwd, playwrightRoot);

  const metadata = {
    firefox: {
      executable: build.executablePath,
      sha256: firefox.sha256,
      version: FIREFOX_RUNTIME_VERSION,
      archiveSha256: build.archiveSha256,
    },
  };
  writeFileSync(join(tauri, "generated", "browser.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(tauri, "generated", "VERSION.txt"), `${ALIASMODE_VERSION}\n`, "utf8");
}

if (import.meta.main) {
  try {
    await prepareLinuxBundle();
    console.log("prepared AliasMode Linux bundle");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
