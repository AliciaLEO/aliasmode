/**
 * Local auth-injecting proxy relay.
 *
 * aliasmode launches the CloakBrowser binary as a raw process with `--proxy-server`, but Chromium
 * ignores credentials on that flag. The previous fix — a generated MV3 extension answering
 * `chrome.webRequest.onAuthRequired` — is unreliable: the service worker can't answer the proxy
 * challenge fast enough during a page-load burst, so some requests fail proxy auth
 * (ERR_INVALID_AUTH_CREDENTIALS) and a SPA like LinkedIn drops the session a few seconds after it
 * loads.
 *
 * Instead the browser points at this loopback HTTP relay with NO auth. For an HTTP upstream, the
 * relay injects `Proxy-Authorization` when credentials are configured. For SOCKS5, it performs RFC 1928/1929 itself and carries the
 * browser's HTTP/CONNECT traffic through that tunnel. The latter is important for packaged kernels
 * older than CloakBrowser 0.3.24, where inline SOCKS credentials are ignored by Chromium.
 */

import net from "node:net";
import { openSocks5Tunnel } from "./geoip.ts";
import { getSystemProxy, isLoopbackHost, matchesBypass } from "./system-proxy.ts";
import type { ProxySpec } from "./types.ts";

export interface UpstreamProxy {
  /** Omitted for backward-compatible HTTP relay callers. */
  type?: "http" | "socks5";
  host: string;
  port: number;
  user: string;
  pass: string;
}

export interface ProxyRelay {
  /** Loopback port the browser's `--proxy-server` points at. */
  port: number;
  close(): void;
}

export interface RelayOptions {
  /** Bind to this exact loopback port (omitted/0 = ephemeral). Used to re-bind a survivor after a
   *  manager restart, since the running browser's `--proxy-server` still points at the old port. */
  port?: number;
  log?: (msg: string) => void;
  viaSystemProxy?: boolean;
}

const MAX_HEAD = 64 * 1024; // cap a request/response head so a never-terminating head can't grow unbounded

type TrackSocket = (socket: net.Socket) => net.Socket;
const UPSTREAM_CONNECT_TIMEOUT_MS = 10_000;

export async function connectUpstream(
  up: UpstreamProxy,
  via: { host: string; port: number } | null,
  log: (msg: string) => void,
  track: TrackSocket = (socket) => socket,
): Promise<{ socket: net.Socket; pending: Buffer }> {
  const socket = track(net.connect({ host: (via ?? up).host, port: (via ?? up).port }));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("system proxy connection timed out")), UPSTREAM_CONNECT_TIMEOUT_MS);
    const onConnect = () => {
      clearTimeout(timer);
      socket.removeListener("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.removeListener("connect", onConnect);
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  }).catch((error) => {
    socket.destroy();
    throw error;
  });
  if (!via) return { socket, pending: Buffer.alloc(0) };
  socket.write([
    `CONNECT ${up.host}:${up.port} HTTP/1.1`,
    `Host: ${up.host}:${up.port}`,
    "Connection: keep-alive",
    "",
    "",
  ].join("\r\n"));
  let response = Buffer.alloc(0);
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("system proxy CONNECT timed out"));
    }, UPSTREAM_CONNECT_TIMEOUT_MS);
    const onData = (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      const end = response.indexOf("\r\n\r\n");
      if (end < 0) {
        if (response.length > MAX_HEAD) {
          clearTimeout(timer);
          socket.destroy();
          reject(new Error("system proxy CONNECT response too large"));
        }
        return;
      }
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      const status = response.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      if (!/\s2\d\d\s/.test(status)) {
        socket.destroy();
        reject(new Error(`system proxy CONNECT refused: ${status}`));
        return;
      }
      resolve({ socket, pending: response.subarray(end + 4) });
    };
    socket.on("data", onData);
    const onError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    socket.once("error", onError);
  });
}

/** Start a loopback relay that forwards to `up`, injecting its credentials. Resolves once listening. */
export function startProxyRelay(up: UpstreamProxy, opts: RelayOptions = {}): Promise<ProxyRelay> {
  const auth = up.user ? "Basic " + Buffer.from(`${up.user}:${up.pass}`).toString("base64") : null;
  const log = opts.log ?? (() => {});
  let via: { host: string; port: number } | null = null;
  // server.close() only stops accepting new clients; it deliberately waits for
  // existing sockets and does not destroy them. Track both sides of every relay
  // connection so closing a profile cannot leave a stalled CONNECT/upstream
  // socket keeping the Bun process and its buffers alive indefinitely.
  const sockets = new Set<net.Socket>();
  const track: TrackSocket = (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = net.createServer((client) => handleClient(track(client), up, auth, via, log, track));
  server.on("error", (e) => log(`proxy relay server error: ${e.message}`));
  return new Promise((resolve, reject) => {
    const onErr = (e: Error) => reject(e);
    server.once("error", onErr);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      server.removeListener("error", onErr);
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      if (opts.viaSystemProxy) {
        const detected = getSystemProxy();
        const loops = detected && isLoopbackHost(detected.host) && detected.port === port;
        const sameUpstream = detected && detected.host.toLowerCase() === up.host.toLowerCase() && detected.port === up.port;
        if (!detected) log("no system proxy detected, connecting directly");
        else if (matchesBypass(up.host, detected.bypass)) log(`system proxy bypassed for ${up.host}, connecting directly`);
        else if (loops || sameUpstream) log("system proxy loop detected, connecting directly");
        else via = { host: detected.host, port: detected.port };
      }
      let closed = false;
      resolve({
        port,
        close: () => {
          if (closed) return;
          closed = true;
          for (const socket of sockets) socket.destroy();
          sockets.clear();
          server.close();
        },
      });
    });
  });
}

function handleClient(
  client: net.Socket,
  up: UpstreamProxy,
  auth: string | null,
  via: { host: string; port: number } | null,
  log: (m: string) => void,
  track: TrackSocket,
): void {
  client.on("error", () => client.destroy());
  let buf = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const headEnd = buf.indexOf("\r\n\r\n");
    if (headEnd === -1) {
      if (buf.length > MAX_HEAD) client.destroy();
      return;
    }
    client.removeListener("data", onData);
    const head = buf.subarray(0, headEnd + 4).toString("latin1");
    const rest = buf.subarray(headEnd + 4); // bytes already past the head (a plain-HTTP body, usually empty)
    const firstLine = head.split("\r\n")[0] ?? "";
    if (/^CONNECT\s/i.test(firstLine)) connectTunnel(client, up, auth, via, firstLine, rest, log, track);
    else plainHttp(client, up, auth, via, head, rest, log, track);
  };
  client.on("data", onData);
}

/** HTTPS: open the upstream tunnel with auth, then pipe raw bytes (TLS is opaque). */
function connectTunnel(
  client: net.Socket,
  up: UpstreamProxy,
  auth: string | null,
  via: { host: string; port: number } | null,
  firstLine: string,
  rest: Buffer,
  log: (m: string) => void,
  track: TrackSocket,
): void {
  const target = firstLine.split(/\s+/)[1] ?? ""; // "host:port"
  if (up.type === "socks5") {
    void connectSocksTunnel(client, up, target, rest, via, log, track);
    return;
  }
  if (!via) {
    // Keep the default direct-connect path intentionally byte-identical.
    const upSock = track(net.connect({ host: up.host, port: up.port }));
    upSock.on("error", (e) => { log(`upstream CONNECT error for ${target}: ${e.message}`); client.destroy(); });
    client.on("error", () => upSock.destroy());
    client.once("close", () => upSock.destroy());
    upSock.on("connect", () => {
      const headers = [
        `CONNECT ${target} HTTP/1.1`,
        `Host: ${target}`,
        ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
        "",
        "",
      ];
      upSock.write(headers.join("\r\n"));
    });
    let rbuf = Buffer.alloc(0);
    const onUpData = (chunk: Buffer) => {
      rbuf = Buffer.concat([rbuf, chunk]);
      const end = rbuf.indexOf("\r\n\r\n");
      if (end === -1) {
        if (rbuf.length > MAX_HEAD) { client.destroy(); upSock.destroy(); }
        return;
      }
      upSock.removeListener("data", onUpData);
      const status = (rbuf.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "");
      if (!/\s2\d\d\s/.test(status)) {
        log(`upstream refused CONNECT ${target}: ${status}`);
        client.destroy();
        upSock.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection established\r\n\r\n");
      const extra = rbuf.subarray(end + 4);
      if (extra.length) client.write(extra);
      if (rest.length) upSock.write(rest);
      upSock.pipe(client);
      client.pipe(upSock);
    };
    upSock.on("data", onUpData);
    upSock.on("close", () => client.destroy());
    return;
  }
  void connectUpstream(up, via, log, track).then(({ socket: upSock, pending }) => {
  const onUpError = (e: Error) => { log(`upstream CONNECT error for ${target}: ${e.message}`); client.destroy(); };
  upSock.on("error", onUpError);
  client.on("error", () => upSock.destroy());
  // In particular, cover a browser abandoning CONNECT before the upstream has
  // replied: the streams are not piped yet, so normal pipe end-propagation does
  // not exist and the upstream socket otherwise survives the client.
  client.once("close", () => upSock.destroy());
  let rbuf = Buffer.alloc(0);
  const onUpData = (chunk: Buffer) => {
    rbuf = Buffer.concat([rbuf, chunk]);
    const end = rbuf.indexOf("\r\n\r\n");
    if (end === -1) {
      if (rbuf.length > MAX_HEAD) { client.destroy(); upSock.destroy(); }
      return;
    }
    upSock.removeListener("data", onUpData);
    const status = (rbuf.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "");
    if (!/\s2\d\d\s/.test(status)) { // not 2xx (e.g. 407) → auth/connect failed
      log(`upstream refused CONNECT ${target}: ${status}`);
      client.destroy();
      upSock.destroy();
      return;
    }
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    const extra = rbuf.subarray(end + 4); // any tunnel bytes that arrived with the response
    if (extra.length) client.write(extra);
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  };
  upSock.on("data", onUpData);
  const sendConnect = () => {
    const headers = [
      `CONNECT ${target} HTTP/1.1`,
      `Host: ${target}`,
      ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
      "",
      "",
    ];
    upSock.write(headers.join("\r\n"));
    if (pending.length) onUpData(pending);
  };
  sendConnect();
  upSock.on("close", () => client.destroy());
  }).catch((error) => {
    log(`upstream CONNECT error for ${target}: ${error instanceof Error ? error.message : error}`);
    client.destroy();
  });
}

function parseAuthority(raw: string, defaultPort: number): { host: string; port: number } {
  let url: URL;
  try {
    url = new URL(`http://${raw}`);
  } catch {
    throw new Error("invalid proxy target authority");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port || defaultPort);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535 || url.username || url.password) {
    throw new Error("invalid proxy target authority");
  }
  return { host, port };
}

function socksSpec(up: UpstreamProxy): ProxySpec {
  return {
    type: "socks5",
    host: up.host,
    port: String(up.port),
    user: up.user,
    pass: up.pass,
  };
}



async function openSocks5OverSocket(
  proxy: ProxySpec,
  host: string,
  port: number,
  socket: net.Socket,
  initial: Buffer,
): Promise<net.Socket> {
  let buffered = initial;
  const onTimeout = () => socket.destroy(new Error("SOCKS5 proxy handshake timed out"));
  socket.setTimeout(10_000);
  socket.once("timeout", onTimeout);
  const read = async (size: number): Promise<Buffer> => {
    while (buffered.length < size) {
      const chunk = await new Promise<Buffer>((resolve, reject) => {
        const onData = (value: Buffer) => { cleanup(); resolve(value); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const onClose = () => { cleanup(); reject(new Error("SOCKS5 socket closed")); };
        const cleanup = () => {
          socket.removeListener("data", onData);
          socket.removeListener("error", onError);
          socket.removeListener("close", onClose);
        };
        socket.once("data", onData);
        socket.once("error", onError);
        socket.once("close", onClose);
      });
      buffered = Buffer.concat([buffered, chunk]);
    }
    const result = buffered.subarray(0, size);
    buffered = buffered.subarray(size);
    return result;
  };
  try {
    const wantsAuth = !!proxy.user;
    socket.write(Buffer.from(wantsAuth ? [5, 1, 2] : [5, 1, 0]));
    const greeting = await read(2);
    if (greeting[0] !== 5 || greeting[1] === 0xff) throw new Error("SOCKS5 proxy rejected all authentication methods");
    if (wantsAuth) {
      if (greeting[1] !== 2) throw new Error("SOCKS5 proxy refused required username/password authentication");
      const user = Buffer.from(proxy.user, "utf8");
      const pass = Buffer.from(proxy.pass, "utf8");
      socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
      const auth = await read(2);
      if (auth[0] !== 1 || auth[1] !== 0) throw new Error("SOCKS5 proxy authentication failed");
    } else if (greeting[1] !== 0) {
      throw new Error(`SOCKS5 proxy selected unsupported authentication method ${greeting[1]}`);
    }
    const domain = Buffer.from(host, "ascii");
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, domain.length]), domain, Buffer.from([(port >> 8) & 0xff, port & 0xff])]));
    const reply = await read(4);
    if (reply[0] !== 5 || reply[1] !== 0) throw new Error(`SOCKS5 CONNECT failed with status ${reply[1]}`);
    const addressLength = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await read(1))[0]! : -1;
    if (addressLength < 0) throw new Error(`SOCKS5 CONNECT returned unknown address type ${reply[3]}`);
    await read(addressLength + 2);
    socket.setTimeout(0);
    socket.removeListener("timeout", onTimeout);
    return socket;
  } catch (error) {
    socket.removeListener("timeout", onTimeout);
    socket.destroy();
    throw error;
  }
}
async function connectSocksTunnel(
  client: net.Socket,
  up: UpstreamProxy,
  target: string,
  rest: Buffer,
  via: { host: string; port: number } | null,
  log: (m: string) => void,
  track: TrackSocket,
): Promise<void> {
  let upSock: net.Socket | undefined;
  try {
    const destination = parseAuthority(target, 443);
    client.once("close", () => upSock?.destroy());
    client.on("error", () => upSock?.destroy());
    if (via) {
      const connected = await connectUpstream(up, via, log, track);
      upSock = await openSocks5OverSocket(socksSpec(up), destination.host, destination.port, connected.socket, connected.pending);
    } else {
      upSock = await openSocks5Tunnel(
        socksSpec(up), destination.host, destination.port, 10_000,
        (socket) => { upSock = track(socket); },
      );
    }
    if (!upSock) throw new Error("SOCKS5 tunnel did not create a socket");
    if (client.destroyed) {
      upSock.destroy();
      return;
    }

    upSock.on("error", (error) => {
      log(`SOCKS5 tunnel error for ${target}: ${error.message}`);
      client.destroy();
    });
    upSock.on("close", () => client.destroy());
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  } catch (error) {
    log(`SOCKS5 CONNECT failed for ${target}: ${error instanceof Error ? error.message : error}`);
    upSock?.destroy();
    client.destroy();
  }
}

/** Plain HTTP: inject auth into the request head and force the connection closed after one response,
 *  so the browser opens a fresh (re-injected) connection for any follow-up request. */
function plainHttp(
  client: net.Socket,
  up: UpstreamProxy,
  auth: string | null,
  via: { host: string; port: number } | null,
  head: string,
  rest: Buffer,
  log: (m: string) => void,
  track: TrackSocket,
): void {
  if (up.type === "socks5") {
    void plainHttpViaSocks(client, up, head, rest, via, log, track);
    return;
  }
  const lines = head.split("\r\n");
  const reqLine = lines[0] ?? "";
  const headers = lines
    .slice(1)
    .filter((l) => l !== "" && !/^(proxy-authorization|connection|proxy-connection)\s*:/i.test(l));
  const rebuilt = [
    reqLine,
    ...headers,
    ...(auth ? [`Proxy-Authorization: ${auth}`] : []),
    "Connection: close",
    "Proxy-Connection: close",
    "",
    "",
  ].join("\r\n");

  void connectUpstream(up, via, log, track).then(({ socket: upSock, pending }) => {
  const onUpError = (e: Error) => { log(`upstream HTTP error: ${e.message}`); client.destroy(); };
  upSock.on("error", onUpError);
  client.on("error", () => upSock.destroy());
  client.once("close", () => upSock.destroy());
  upSock.write(rebuilt);
  if (rest.length) upSock.write(rest);
  if (pending.length) client.write(pending);
  upSock.pipe(client);
  client.pipe(upSock);
  upSock.on("close", () => client.destroy());
  }).catch((error) => {
    log(`upstream HTTP error: ${error instanceof Error ? error.message : error}`);
    client.destroy();
  });
}

async function plainHttpViaSocks(
  client: net.Socket,
  up: UpstreamProxy,
  head: string,
  rest: Buffer,
  via: { host: string; port: number } | null,
  log: (m: string) => void,
  track: TrackSocket,
): Promise<void> {
  let upSock: net.Socket | undefined;
  try {
    const lines = head.split("\r\n");
    const match = (lines[0] ?? "").match(/^(\S+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/i);
    if (!match) throw new Error("invalid HTTP proxy request line");
    const [, method, requestTarget, version] = match;
    const hostHeader = lines.slice(1).find((line) => /^host\s*:/i.test(line))?.replace(/^host\s*:\s*/i, "") ?? "";
    let destination: { host: string; port: number };
    let originTarget = requestTarget!;
    if (/^http:\/\//i.test(requestTarget!)) {
      const url = new URL(requestTarget!);
      destination = { host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 80) };
      originTarget = `${url.pathname || "/"}${url.search}`;
    } else {
      destination = parseAuthority(hostHeader, 80);
    }
    const headers = lines
      .slice(1)
      .filter((line) => line !== "" && !/^(proxy-authorization|connection|proxy-connection)\s*:/i.test(line));
    const rebuilt = [
      `${method} ${originTarget} ${version}`,
      ...headers,
      "Connection: close",
      "",
      "",
    ].join("\r\n");
    client.once("close", () => upSock?.destroy());
    client.on("error", () => upSock?.destroy());
    if (via) {
      const connected = await connectUpstream(up, via, log, track);
      upSock = await openSocks5OverSocket(socksSpec(up), destination.host, destination.port, connected.socket, connected.pending);
    } else {
      upSock = await openSocks5Tunnel(
        socksSpec(up), destination.host, destination.port, 10_000,
        (socket) => { upSock = track(socket); },
      );
    }
    if (client.destroyed) {
      upSock.destroy();
      return;
    }
    upSock.on("error", (error) => {
      log(`SOCKS5 HTTP tunnel error: ${error.message}`);
      client.destroy();
    });
    upSock.on("close", () => client.destroy());
    upSock.write(rebuilt);
    if (rest.length) upSock.write(rest);
    upSock.pipe(client);
    client.pipe(upSock);
  } catch (error) {
    log(`SOCKS5 HTTP request failed: ${error instanceof Error ? error.message : error}`);
    upSock?.destroy();
    client.destroy();
  }
}
