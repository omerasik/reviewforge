import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:13040");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("Loopback demo server required");
for (let attempt = 0; ; attempt += 1) {
  try {
    const response = await fetch(new URL("/health", base), { signal: AbortSignal.timeout(1000), redirect: "error" });
    assert.equal(response.status, 200);
    await response.body?.cancel();
    break;
  } catch (error) {
    if (attempt >= 29) throw error;
    await delay(1000);
  }
}
const page = await fetch(base, { redirect: "error", signal: AbortSignal.timeout(3000) });
assert.equal(page.status, 200);
assert.match(await page.text(), /assets\/main\.js/);
assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
for (const file of ["main.js", "main.css"]) {
  const asset = await fetch(new URL("/assets/" + file, base), { signal: AbortSignal.timeout(3000) });
  assert.equal(asset.status, 200);
  await asset.body?.cancel();
}
const denied = await fetch(new URL("/api/reviews", base));
assert.equal(denied.status, 401);
await denied.body?.cancel();
const reviews = await fetch(new URL("/api/reviews", base), {
  headers: { Authorization: "Bearer reviewforge-ci-operator-credential-only" }, signal: AbortSignal.timeout(3000)
});
assert.equal(reviews.status, 200);
assert.deepEqual(await reviews.json(), []);
console.log("PASS: running container health, dashboard assets, CSP and operator authorization; no external calls");
