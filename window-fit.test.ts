import { test, expect } from "bun:test";
import { claimedScreenArea, fitWindow, watchWindowFit } from "./window-fit.ts";
import { buildNewProfile } from "./create.ts";

const AREA = { left: 0, top: 0, width: 1440, height: 852 };

test("a maximized window larger than the profile's screen becomes its available screen, at the same corner", () => {
  // CDP reports a maximized window with its hidden border; the page reads (0,0,1920,1032).
  expect(fitWindow({ left: -4, top: -4, width: 1928, height: 1040, windowState: "maximized" }, AREA)).toEqual(AREA);
  // On a second monitor to the right, the window stays there.
  expect(fitWindow({ left: 1916, top: -8, width: 1936, height: 1048, windowState: "maximized" }, AREA))
    .toEqual({ left: 1924, top: 0, width: 1440, height: 852 });
  // A Mac reports a zoomed window without a border, below its menu bar.
  expect(fitWindow({ left: 0, top: 25, width: 1470, height: 931, windowState: "maximized" }, AREA))
    .toEqual({ left: 0, top: 25, width: 1440, height: 852 });
  // On a display no larger than the profile's screen, maximized already fits.
  expect(fitWindow({ left: -4, top: -4, width: 1374, height: 736, windowState: "maximized" }, AREA)).toBeNull();
  expect(fitWindow({ left: -8, top: -8, width: 1456, height: 868, windowState: "maximized" }, AREA)).toBeNull();
});

test("a normal window is shrunk only on the side that is too large, and never moved", () => {
  expect(fitWindow({ left: 0, top: 0, width: 936, height: 810, windowState: "normal" }, AREA)).toBeNull();
  expect(fitWindow({ left: 100, top: 20, width: 1700, height: 1000, windowState: "normal" }, AREA))
    .toEqual({ left: 100, top: 20, width: 1440, height: 852 });
  // A window snapped to the left half of a 1920x1080 display keeps its width.
  expect(fitWindow({ left: 0, top: 0, width: 960, height: 1032, windowState: "normal" }, AREA))
    .toEqual({ left: 0, top: 0, width: 960, height: 852 });
  // Position is the user's, even past the claimed screen's edge or on another monitor.
  expect(fitWindow({ left: 2400, top: 300, width: 936, height: 810, windowState: "normal" }, AREA)).toBeNull();
});

test("fullscreen and minimized windows are left alone", () => {
  expect(fitWindow({ left: 0, top: 0, width: 1920, height: 1080, windowState: "fullscreen" }, AREA)).toBeNull();
  expect(fitWindow({ left: -32000, top: -32000, width: 160, height: 28, windowState: "minimized" }, AREA)).toBeNull();
});

test("the claimed area is the captured available screen, then the stored capture, then the profile's screen", () => {
  const profile = { ...buildNewProfile({ screen: "1440x900" }, () => false) };
  const screen = { width: 1440, height: 900, availWidth: 1440, availHeight: 852, availLeft: 0, availTop: 0, colorDepth: 24, dpr: 1 };
  expect(claimedScreenArea(profile, { screen })).toEqual(AREA);
  expect(claimedScreenArea(profile, { screen: { ...screen, availTop: 33, availHeight: 781 } })).toEqual({ ...AREA, top: 33, height: 781 });
  // A capture that failed at this launch still has the taskbar from an earlier one.
  expect(claimedScreenArea({ ...profile, fpObserved: { availableScreen: "1440*852" } }, null)).toEqual(AREA);
  expect(claimedScreenArea({ ...profile, fpObserved: { availableScreen: "2560*1392" } }, null)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
  expect(claimedScreenArea(profile, null)).toEqual({ left: 0, top: 0, width: 1440, height: 900 });
});

/** A browser socket whose windows the test sets; records each setWindowBounds. */
function fakeBrowser(windows: Map<number, any>, refuse = false) {
  const sets: any[] = [];
  let socket: any;
  class FakeSocket {
    onopen?: () => void;
    onmessage?: (event: { data: string }) => void;
    onclose?: () => void;
    onerror?: () => void;
    closed = false;
    constructor(public url: string) {
      socket = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      let result: any = {};
      if (method === "Target.getTargets") {
        result = { targetInfos: [...windows.keys()].map((w) => ({ type: "page", targetId: `t${w}` })).concat({ type: "service_worker", targetId: "sw" } as any) };
      } else if (method === "Browser.getWindowForTarget") {
        result = { windowId: Number(params.targetId.slice(1)) };
      } else if (method === "Browser.getWindowBounds") {
        result = { bounds: windows.get(params.windowId) };
      } else if (method === "Browser.setWindowBounds") {
        sets.push(params);
        if (!refuse) windows.set(params.windowId, { windowState: "normal", ...windows.get(params.windowId), ...params.bounds });
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result }) }));
    }
    close() { this.closed = true; }
  }
  return { sets, Socket: FakeSocket as unknown as typeof WebSocket, socket: () => socket };
}

const ticks = (n: number) => new Promise((r) => setTimeout(r, n * 5 + 5));

test("the watcher fixes a maximize at once and a dragged window after it settles", async () => {
  const windows = new Map<number, any>([[1, { left: 0, top: 0, width: 936, height: 810, windowState: "normal" }]]);
  const browser = fakeBrowser(windows);
  const fit = watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket });
  await ticks(2);
  expect(browser.sets).toEqual([]);

  windows.set(1, { left: -4, top: -4, width: 1928, height: 1040, windowState: "maximized" });
  await ticks(2);
  expect(browser.sets).toEqual([{ windowId: 1, bounds: { windowState: "normal" } }, { windowId: 1, bounds: AREA }]);

  // A drag in progress changes bounds every read; it is fixed only once they hold still.
  for (const width of [1500, 1600, 1700]) {
    windows.set(1, { left: 0, top: 0, width, height: 800, windowState: "normal" });
    await new Promise((r) => setTimeout(r, 4));
  }
  await ticks(3);
  expect(browser.sets.at(-1)).toEqual({ windowId: 1, bounds: { left: 0, top: 0, width: 1440, height: 800 } });
  fit.stop();
  expect(browser.socket().closed).toBe(true);
});

test("a fix the window manager refuses is not repeated", async () => {
  const windows = new Map<number, any>([[1, { left: -4, top: -4, width: 1928, height: 1040, windowState: "maximized" }]]);
  const browser = fakeBrowser(windows, true);
  const fit = watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket });
  await ticks(8);
  expect(browser.sets.length).toBe(2);
  // Once the user changes the window, it is tried again.
  windows.set(1, { left: -4, top: -4, width: 1928, height: 1041, windowState: "maximized" });
  await ticks(2);
  expect(browser.sets.length).toBe(4);
  fit.stop();
});

test("the watcher ends when the browser closes its socket", async () => {
  const browser = fakeBrowser(new Map());
  let closed = 0;
  watchWindowFit("ws://fake", AREA, { intervalMs: 5, WebSocket: browser.Socket, onClose: () => closed++ });
  await ticks(1);
  browser.socket().onclose();
  browser.socket().onclose();
  expect(closed).toBe(1);
});
