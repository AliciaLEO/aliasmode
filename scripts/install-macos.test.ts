import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (path: string) => readFileSync(join(import.meta.dir, "..", path), "utf8");

test("the macOS installer, build and release workflows agree on the release file names", () => {
  const installer = read("scripts/install-macos.sh");
  const build = read(".github/workflows/macos-desktop.yml");
  const release = read(".github/workflows/macos-release.yml");

  expect(installer).toContain('archive="AliasMode_${version}_aarch64.app.tar.gz"');
  expect(installer).toContain('"$base/v$version/SHA256SUMS-macos.txt"');
  expect(build).toContain("AliasMode_${version}_aarch64.app.tar.gz");
  expect(build).toContain("SHA256SUMS-macos.txt");
  expect(release).toContain("AliasMode_${VERSION}_aarch64.app.tar.gz");
  expect(release).toContain("SHA256SUMS-macos.txt");
  // The Windows update feed accepts exactly one platform, so macOS files must never enter it.
  expect(release).not.toContain("latest-v2.json");
  expect(release).not.toContain("--clobber");
});
