import { test, expect } from "bun:test";
import { lookupTimezones, attachTimezones } from "./geoip.ts";

const proxy = (host: string) => ({ type: "http" as const, host, port: "8080", user: "", pass: "" });

function fakeFetch(byIp: Record<string, string>) {
  return async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Array<{ query: string }>;
    return {
      json: async () =>
        body.map(({ query }) =>
          byIp[query]
            ? { query, status: "success", timezone: byIp[query] }
            : { query, status: "fail" },
        ),
    };
  };
}

test("lookupTimezones maps resolved IPs and skips failures", async () => {
  const tz = await lookupTimezones(
    ["1.2.3.4", "5.6.7.8", "9.9.9.9"],
    fakeFetch({ "1.2.3.4": "America/New_York", "5.6.7.8": "Europe/London" }),
  );
  expect(tz.get("1.2.3.4")).toBe("America/New_York");
  expect(tz.get("5.6.7.8")).toBe("Europe/London");
  expect(tz.has("9.9.9.9")).toBe(false);
});

test("lookupTimezones returns empty when the lookup throws (offline)", async () => {
  const tz = await lookupTimezones(["1.2.3.4"], async () => {
    throw new Error("network down");
  });
  expect(tz.size).toBe(0);
});

test("attachTimezones falls back to the proxy host when the exit lookup fails", async () => {
  const profiles = [
    { proxy: proxy("1.2.3.4"), timezone: "" },
    { proxy: proxy("5.6.7.8"), timezone: "" },
    { proxy: null, timezone: "" },
  ];
  const { resolved } = await attachTimezones(profiles, fakeFetch({ "1.2.3.4": "America/New_York", "5.6.7.8": "Europe/London" }));
  expect(resolved).toBe(2);
  expect(profiles[0]!.timezone).toBe("America/New_York");
  expect(profiles[1]!.timezone).toBe("Europe/London");
  expect(profiles[2]!.timezone).toBe(""); // no proxy → unchanged
});

test("attachTimezones prefers the timezone of the proxy's exit IP over its host", async () => {
  const profiles = [{ proxy: proxy("gate.example.net"), timezone: "" }];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, async (url, init) => {
    calls.push(`${url} via ${(init as { proxy?: string }).proxy ?? "direct"}`);
    return { json: async () => ({ status: "success", timezone: "America/Toronto" }) };
  });
  expect(resolved).toBe(1);
  expect(profiles[0]!.timezone).toBe("America/Toronto");
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^http:\/\/ip-api\.com\/json\/.* via http:\/\/127\.0\.0\.1:\d+$/);
});

test("attachTimezones asks an IPv6 service when the IPv4-only exit lookup fails", async () => {
  const profiles = [{ proxy: proxy("gate.example.net"), timezone: "" }];
  const calls: string[] = [];
  const { resolved } = await attachTimezones(profiles, async (url) => {
    calls.push(url);
    if (url.includes("ip-api.com")) throw new Error("no IPv4 route");
    return { json: async () => ({ ip: "2001:db8::1", timezone: "Europe/Berlin" }) };
  });
  expect(resolved).toBe(1);
  expect(profiles[0]!.timezone).toBe("Europe/Berlin");
  expect(calls[1]).toBe("https://v6.ipinfo.io/json");
});
