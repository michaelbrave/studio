// Who may use the hub. Its API starts agents and answers their permission requests, so it must
// never be open to anyone who can reach the port.
//
// - This machine (loopback): allowed, as long as the Host header names localhost. That stops a
//   web page from reaching the hub through DNS rebinding.
// - Another computer (only when the hub listens beyond loopback: `studio lan on`): it needs the
//   access key, once, in the link `studio lan` prints (`/?key=...`). The hub swaps it for an
//   HttpOnly cookie and drops it from the address bar.
// - Any browser POST whose Origin isn't the hub itself is refused (cross-site requests).
// - /mcp has its own bearer token (mcp.ts), so it's left to that check.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

const COOKIE = "studio_key";
const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Hub settings that `studio` writes (STUDIO_HOME/settings.json). Env vars win over these. */
export interface HubSettings {
  /** Interface to listen on; "0.0.0.0" opens the hub to the local network (with the key). */
  host?: string;
  /** Extra Host names allowed from loopback, e.g. a Tailscale Serve name. */
  allowedHosts?: string[];
}

export async function readSettings(home: string): Promise<HubSettings> {
  try {
    return JSON.parse(await readFile(join(home, "settings.json"), "utf8")) as HubSettings;
  } catch {
    return {};
  }
}

/** The key other computers need; made once, owner-only. */
export async function accessKey(home: string): Promise<string> {
  const path = join(home, "web-key");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const key = randomBytes(18).toString("base64url");
    await writeFile(path, `${key}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return key;
  }
}

export type Access =
  | { ok: true }
  | { ok: false; status: 401 | 403; reason: string }
  | { ok: false; status: 303; location: string; cookie: string };

export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return rest.join("=");
  }
  return undefined;
}

export function checkAccess(req: IncomingMessage, url: URL, key: string, allowedHosts: string[] = []): Access {
  if (url.pathname === "/mcp") return { ok: true };

  const host = req.headers.host ?? "";
  const origin = req.headers.origin;
  if (req.method !== "GET" && req.method !== "HEAD" && origin !== undefined) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {}
    if (originHost !== host) return { ok: false, status: 403, reason: "cross-site request refused" };
  }

  if (isLoopback(req.socket.remoteAddress)) {
    const name = host.replace(/:\d+$/, "").toLowerCase();
    if (LOCAL_NAMES.has(name) || allowedHosts.includes(name)) return { ok: true };
    // Not a localhost name, but it came over loopback: either DNS rebinding or a local proxy
    // (e.g. Tailscale Serve). A proxy's visitors go through the key like any other computer.
  }

  const cookie = cookieValue(req.headers.cookie);
  if (cookie !== undefined && same(cookie, key)) return { ok: true };

  const given = url.searchParams.get("key");
  if (given !== null && same(given, key)) {
    url.searchParams.delete("key");
    return {
      ok: false,
      status: 303,
      location: url.pathname + url.search,
      cookie: `${COOKIE}=${key}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`,
    };
  }
  return { ok: false, status: 401, reason: "this computer needs Studio's access link" };
}

export const LOCKED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Studio</title><body style="font:16px system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem;color:#222">
<h1>Studio is locked</h1><p>To use Studio from this computer, open the access link. On the machine that runs
Studio, type:</p><pre style="background:#eee;padding:.75rem">studio lan</pre><p>and open the link it prints here.
You only need to do this once per browser.</p></body>`;
