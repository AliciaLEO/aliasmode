/**
 * Keeps each Chromium 155 window no larger than the screen its profile claims.
 *
 * A page reads screen.* from the profile, but outerWidth, innerHeight and
 * screenX from the real window. A window maximized on a display bigger than
 * that screen is bigger than the screen the page sees, and a page finds that in
 * one comparison (innerHeight > screen.height). This reads each window's bounds
 * over the browser's CDP socket and shrinks any window larger than the
 * profile's available screen to fit it: a maximized one becomes the size a
 * maximized window has on that screen, at the same corner. The position is the
 * user's: windows can still sit anywhere, on any monitor. Fullscreen and
 * minimized windows are left alone. It never attaches to a page.
 */

import type { FingerprintSample } from "./diagnose.ts";
import type { Profile } from "./types.ts";

export interface ScreenArea {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WindowBounds extends Partial<ScreenArea> {
  windowState?: string;
}

/** The profile's available screen as its pages read it, or its whole screen when the launch capture failed. */
export function claimedScreenArea(profile: Profile, sample: FingerprintSample | null): ScreenArea {
  const screen = sample?.screen;
  return screen?.availWidth && screen.availHeight
    ? { left: screen.availLeft ?? 0, top: screen.availTop ?? 0, width: screen.availWidth, height: screen.availHeight }
    : { left: 0, top: 0, width: profile.screenWidth, height: profile.screenHeight };
}

/**
 * On Windows, CDP reports a maximized window with its hidden resize border, which hangs
 * off the monitor: (-4,-4,1032,776) for a page that reads (0,0,1024,768). The border is
 * the same on every side and at most 16 px at 150%. Other systems have none.
 */
function maximizedBorder({ left = 0, top = 0 }: WindowBounds): number {
  const insets = [-left, -top].filter((inset) => inset > 0 && inset <= 16);
  return insets.length ? Math.min(...insets) : 0;
}

/** The bounds that make a window fit `area`'s size, or null when it already does or must be left alone. */
export function fitWindow(bounds: WindowBounds, area: ScreenArea): ScreenArea | null {
  const { windowState } = bounds;
  if (windowState === "minimized" || windowState === "fullscreen") return null;
  if (bounds.left === undefined || bounds.top === undefined || bounds.width === undefined || bounds.height === undefined) return null;
  const border = windowState === "maximized" ? maximizedBorder(bounds) : 0;
  const left = bounds.left + border;
  const top = bounds.top + border;
  const width = bounds.width - 2 * border;
  const height = bounds.height - 2 * border;
  if (width <= area.width && height <= area.height) return null;
  return { left, top, width: Math.min(width, area.width), height: Math.min(height, area.height) };
}

export interface WindowFitOptions {
  intervalMs?: number;
  log?: (msg: string) => void;
  onClose?: () => void;
  WebSocket?: typeof WebSocket;
}

interface WindowTrack {
  seen: string;
  /** The last read was answered with a fix; a window still too large after it is left for the user. */
  fixed: boolean;
  giveUp?: string;
}

/**
 * Watch every window of the browser at `ws` until its socket closes or stop() is called.
 * New windows are found within five reads. A maximized window is fixed on the read that finds
 * it. A window being dragged larger is fixed once its bounds stop changing, so the fix never
 * fights the mouse. A fix the window manager refuses is not repeated until the window changes
 * again, so there is no resize loop.
 */
export function watchWindowFit(ws: string, area: ScreenArea, opts: WindowFitOptions = {}): { stop(): void } {
  const intervalMs = opts.intervalMs ?? 1000;
  const Socket = opts.WebSocket ?? WebSocket;
  const socket = new Socket(ws);
  const pending = new Map<number, (result: any) => void>();
  const windows = new Map<number, WindowTrack>();
  let nextId = 1;
  let reads = 0;
  let windowIds: number[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const resolve of pending.values()) resolve(undefined);
    pending.clear();
    try { socket.close(); } catch {}
    opts.onClose?.();
  };

  const tick = async () => {
    // Look for new windows on every fifth read; in between, read only the windows already known.
    if (reads++ % 5 === 0) {
      const pages = ((await send("Target.getTargets"))?.targetInfos ?? []).filter((target: any) => target.type === "page");
      const ids = new Set<number>();
      for (const page of pages) {
        const found = await send("Browser.getWindowForTarget", { targetId: page.targetId });
        if (typeof found?.windowId === "number") ids.add(found.windowId);
      }
      windowIds = [...ids];
      for (const id of windows.keys()) if (!ids.has(id)) windows.delete(id);
    }
    for (const windowId of windowIds) {
      const bounds: WindowBounds | undefined = (await send("Browser.getWindowBounds", { windowId }))?.bounds;
      if (closed) return;
      if (!bounds) continue;
      const seen = JSON.stringify(bounds);
      const track = windows.get(windowId) ?? { seen: "", fixed: false };
      windows.set(windowId, track);
      const fit = fitWindow(bounds, area);
      const settled = seen === track.seen;
      track.seen = seen;
      if (!fit) { track.fixed = false; continue; }
      if (track.fixed) { track.fixed = false; track.giveUp = seen; continue; }
      if (seen === track.giveUp) continue;
      if (bounds.windowState === "normal" && !settled) continue;
      track.fixed = true;
      // Chromium ignores bounds sent with the restore of a maximized window, so restore first.
      if (bounds.windowState === "maximized") await send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
      if (await send("Browser.setWindowBounds", { windowId, bounds: fit })) {
        opts.log?.(`window ${seen} resized to fit the profile's ${area.width}x${area.height} available screen`);
      }
    }
  };
  const loop = () => {
    if (closed) return;
    tick().catch(() => {}).finally(() => {
      if (!closed) timer = setTimeout(loop, intervalMs);
    });
  };

  socket.onopen = loop;
  socket.onmessage = (event) => {
    let msg: any;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    const resolve = msg?.id === undefined ? undefined : pending.get(msg.id);
    if (!resolve) return;
    pending.delete(msg.id);
    resolve(msg.error ? undefined : msg.result);
  };
  socket.onclose = stop;
  socket.onerror = stop;
  return { stop };
}
