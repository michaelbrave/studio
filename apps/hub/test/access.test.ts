import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { checkAccess } from "../src/access.ts";

const KEY = "s3cret-key";

function req(opts: { from: string; host: string; method?: string; origin?: string; cookie?: string; authorization?: string }): IncomingMessage {
  return {
    method: opts.method ?? "GET",
    headers: { host: opts.host, origin: opts.origin, cookie: opts.cookie, authorization: opts.authorization },
    socket: { remoteAddress: opts.from },
  } as unknown as IncomingMessage;
}
const at = (path: string) => new URL(path, "http://hub");

test("this machine gets in by localhost name; a rebinding Host does not", () => {
  assert.deepEqual(checkAccess(req({ from: "127.0.0.1", host: "127.0.0.1:4600" }), at("/api/state"), KEY), { ok: true });
  assert.deepEqual(checkAccess(req({ from: "::1", host: "localhost:4600" }), at("/"), KEY), { ok: true });
  assert.deepEqual(checkAccess(req({ from: "::ffff:127.0.0.1", host: "localhost" }), at("/"), KEY), { ok: true });
  const rebound = checkAccess(req({ from: "127.0.0.1", host: "evil.example:4600" }), at("/api/state"), KEY);
  assert.equal(rebound.ok, false);
  assert.deepEqual(checkAccess(req({ from: "127.0.0.1", host: "box.tail1.ts.net" }), at("/"), KEY, ["box.tail1.ts.net"]), { ok: true });
});

test("another computer needs the key once, then the cookie", () => {
  const lan = { from: "192.168.1.50", host: "192.168.1.10:4600" };
  const locked = checkAccess(req(lan), at("/api/state"), KEY);
  assert.equal(!locked.ok && locked.status, 401);
  assert.equal(checkAccess(req(lan), at("/?key=wrong"), KEY).ok, false);

  const link = checkAccess(req(lan), at("/?key=" + KEY + "&flat"), KEY);
  assert.ok(!link.ok && link.status === 303);
  assert.equal(link.location, "/?flat=");
  assert.match(link.cookie, /^studio_key=s3cret-key; .*HttpOnly; SameSite=Strict/);

  assert.deepEqual(checkAccess(req({ ...lan, cookie: `a=b; studio_key=${KEY}` }), at("/api/state"), KEY), { ok: true });
  assert.equal(checkAccess(req({ ...lan, cookie: "studio_key=nope" }), at("/api/state"), KEY).ok, false);
  // `studio join` on a support machine sends the key as a header
  assert.deepEqual(checkAccess(req({ ...lan, method: "POST", authorization: `Bearer ${KEY}` }), at("/api/workers"), KEY), { ok: true });
  assert.equal(checkAccess(req({ ...lan, authorization: "Bearer nope" }), at("/api/state"), KEY).ok, false);
});

test("cross-site POSTs are refused even from this machine; /mcp is left to its own token", () => {
  const evil = req({ from: "127.0.0.1", host: "127.0.0.1:4600", method: "POST", origin: "https://evil.example" });
  const r = checkAccess(evil, at("/api/jobs"), KEY);
  assert.equal(!r.ok && r.status, 403);
  const own = req({ from: "127.0.0.1", host: "127.0.0.1:4600", method: "POST", origin: "http://127.0.0.1:4600" });
  assert.deepEqual(checkAccess(own, at("/api/jobs"), KEY), { ok: true });
  assert.deepEqual(checkAccess(req({ from: "10.0.0.5", host: "x" }), at("/mcp"), KEY), { ok: true });
});
