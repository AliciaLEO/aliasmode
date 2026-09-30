import { expect, test } from "bun:test";
import {
  isLoopbackHost,
  matchesBypass,
  normalizeProxyAddress,
  parseWindowsProxySettings,
} from "./system-proxy.ts";

test("system proxy normalization accepts URLs and Windows per-protocol values", () => {
  expect(normalizeProxyAddress(" http://proxy.example:8080 ")).toEqual({ host: "proxy.example", port: 8080 });
  expect(normalizeProxyAddress("https://proxy.example:8443")).toEqual({ host: "proxy.example", port: 8443 });
  expect(normalizeProxyAddress("http=old.example:80; https=new.example:443")).toEqual({ host: "new.example", port: 443 });
  expect(normalizeProxyAddress("broken")).toBeNull();
  expect(normalizeProxyAddress("http://:bad")).toBeNull();
});

test("Windows proxy output is parsed without interpreting PAC settings", () => {
  const parsed = parseWindowsProxySettings(`
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       http=proxy.example:80;https=secure.example:443
    ProxyOverride  REG_MULTI_SZ  <local>;*.example.test
  `);
  expect(parsed).toEqual({
    enabled: true,
    proxy: "http=proxy.example:80;https=secure.example:443",
    bypass: ["<local>", "*.example.test"],
    pac: false,
  });
  expect(parseWindowsProxySettings("AutoConfigURL REG_SZ http://proxy/pac.js").pac).toBe(true);
});

test("system proxy bypass and loopback checks are case-insensitive", () => {
  expect(matchesBypass("api.example.test", ["*.example.test"])).toBe(true);
  expect(matchesBypass("printer", ["<local>"])).toBe(true);
  expect(matchesBypass("api.other.test", ["*.example.test"])).toBe(false);
  expect(isLoopbackHost("LOCALHOST")).toBe(true);
  expect(isLoopbackHost("[::1]")).toBe(true);
  expect(isLoopbackHost("127.0.0.1")).toBe(true);
  expect(isLoopbackHost("192.168.1.1")).toBe(false);
});
