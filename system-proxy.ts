import { execFileSync } from "node:child_process";

export interface SystemProxy {
  host: string;
  port: number;
  bypass: string[];
}

export function normalizeProxyAddress(raw: string): { host: string; port: number } | null {
  let value = raw.trim();
  if (!value) return null;
  const entries = value.split(";").map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry.includes("="))) {
    value = entries.find((entry) => /^https\s*=/i.test(entry))?.split("=").slice(1).join("=")?.trim()
      ?? entries.find((entry) => /^http\s*=/i.test(entry))?.split("=").slice(1).join("=")?.trim()
      ?? "";
  }
  if (!value) return null;
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
    const parsed = new URL(hasScheme ? value : `http://${value}`);
    if (!hasScheme && !parsed.port) return null;
    const port = Number(parsed.port || 80);
    if (!parsed.hostname || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    return { host: parsed.hostname.replace(/^\[|\]$/g, ""), port };
  } catch {
    return null;
  }
}

export function matchesBypass(host: string, bypass: string[]): boolean {
  const name = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (!name) return false;
  return bypass.some((raw) => {
    const pattern = raw.trim().toLowerCase();
    if (!pattern) return false;
    if (pattern === "<local>") return !name.includes(".");
    const normalized = pattern.replace(/^\*\.?/, "");
    return pattern.startsWith("*.") ? (name === normalized || name.endsWith(`.${normalized}`)) : name === pattern;
  });
}

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function parseWindowsProxySettings(output: string): {
  enabled: boolean;
  proxy: string | null;
  bypass: string[];
  pac: boolean;
} {
  const read = (name: string): string | undefined =>
    output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+)$`, "im"))?.[1]?.trim();
  const proxyEnable = read("ProxyEnable");
  const proxy = read("ProxyServer") ?? null;
  const bypass = (read("ProxyOverride") ?? "").split(";").map((value) => value.trim()).filter(Boolean);
  const pac = Boolean(read("AutoConfigURL"));
  return { enabled: proxyEnable === "0x1" || proxyEnable === "1", proxy, bypass, pac };
}

function readWindowsProxy(): SystemProxy | null | "pac" {
  if (process.platform !== "win32") return null;
  let output: string;
  try {
    output = execFileSync("reg", [
      "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings",
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const settings = parseWindowsProxySettings(output);
  if (settings.pac) return "pac";
  if (!settings.enabled || !settings.proxy) return null;
  const proxy = normalizeProxyAddress(settings.proxy);
  return proxy ? { ...proxy, bypass: settings.bypass } : null;
}

export function getSystemProxy(): SystemProxy | null {
  const windows = readWindowsProxy();
  if (windows === "pac") return null;
  if (windows) return windows;
  const proxy = normalizeProxyAddress(
    process.env.HTTPS_PROXY ?? process.env.https_proxy
      ?? process.env.HTTP_PROXY ?? process.env.http_proxy ?? "",
  );
  if (!proxy) return null;
  return {
    ...proxy,
    bypass: (process.env.NO_PROXY ?? process.env.no_proxy ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
  };
}
