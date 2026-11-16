import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Review } from "../src/domain.js";
import { modelAdvisor, supportedSuggestions } from "../src/review.js";
import { fixture, read, sha } from "../scripts/fixture.js";

test("rejects unauthorized deliveries and deduplicates by delivery and head commit", async t => {
  const demo = await fixture();
  t.after(() => demo.close());
  assert.equal((await demo.webhook({ signed: false })).status, 401);
  assert.equal((await demo.webhook({ githubRepo: "denied/repo" })).status, 403);
  assert.equal((await demo.webhook({ event: "push" })).status, 200);
  assert.equal((await demo.operatorCall("", undefined, false)).status, 401);
  const delivery = randomUUID();
  const first = await demo.webhook({ delivery });
  assert.equal(first.status, 202);
  const { id } = await read<{ id: string }>(first);
  assert.equal((await demo.webhook({ delivery, pullHead: "b".repeat(40) })).status, 409);
  for (const options of [{ delivery }, {}]) {
    const replay = await demo.webhook(options);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { id, duplicate: true });
  }
  assert.equal((await read<Review[]>(demo.operatorCall())).length, 1);
});

test("draft separates checks and model suggestions, and publish requires the exact approval", async t => {
  const demo = await fixture();
  t.after(() => demo.close());
  const { id } = await read<{ id: string }>(demo.webhook());
  const analysis = await demo.operatorCall("/" + id + "/analyze", null);
  assert.equal(analysis.status, 200);
  const doc = await read<Review>(analysis);
  assert.equal(doc.status, "ready");
  assert.equal(doc.draft?.risk, "high");
  assert.equal(doc.draft?.scopes.bounded, true);
  assert.equal(doc.draft?.checks[0]?.conclusion, "failure");
  assert.equal(doc.draft?.suggestions.length, 1);
  assert.equal(doc.draft?.suggestions[0]?.file, "src/normalize.ts");
  assert.equal(doc.draft?.suggestions[0]?.line, 8);
  assert.ok(doc.draft?.files.every(file => !Object.hasOwn(file, "patch")));
  assert.equal(demo.posts.length, 0);
  assert.equal((await demo.operatorCall("/" + id + "/publish", { approve: true, sha: "b".repeat(40) })).status, 422);
  assert.equal((await demo.operatorCall("/" + id + "/publish", { approve: true, sha }, false)).status, 401);
  const responses = await Promise.all([
    demo.operatorCall("/" + id + "/publish", { approve: true, sha }),
    demo.operatorCall("/" + id + "/publish", { approve: true, sha })
  ]);
  assert.ok(responses.some(response => response.status === 200));
  assert.equal(demo.posts.length, 1);
  assert.match(demo.posts[0]?.body ?? "", /unit tests · failure[\s\S]+Model suggestions/);
  assert.equal((await read<Review>(demo.operatorCall("/" + id))).status, "published");
});

test("prevents stale-head publication and surfaces GitHub retry timing", async t => {
  const demo = await fixture();
  t.after(() => demo.close());
  const { id } = await read<{ id: string }>(demo.webhook());
  assert.equal((await demo.operatorCall("/" + id + "/analyze", null)).status, 200);
  demo.setHead("b".repeat(40));
  assert.equal((await demo.operatorCall("/" + id + "/publish", { approve: true, sha })).status, 409);
  assert.equal(demo.posts.length, 0);
  const next = await read<{ id: string }>(demo.webhook({ pullHead: "b".repeat(40) }));
  demo.setRateLimited();
  const rate = await demo.operatorCall("/" + next.id + "/analyze", null);
  assert.equal(rate.status, 503);
  assert.equal(rate.headers.get("retry-after"), "21");
  assert.equal((await read<Review>(demo.operatorCall("/" + next.id))).status, "queued");
  assert.equal((await read<Review>(demo.operatorCall("/" + next.id))).analysis_error, "github_rate_limited");
});

test("an ambiguous publication is reconciled without a second GitHub write", async t => {
  const demo = await fixture();
  t.after(() => demo.close());
  const { id } = await read<{ id: string }>(demo.webhook());
  await demo.operatorCall("/" + id + "/analyze", null);
  demo.losePostResponse();
  assert.equal((await demo.operatorCall("/" + id + "/publish", { approve: true, sha })).status, 502);
  assert.equal((await demo.operatorCall("/" + id + "/publish", { approve: true, sha })).status, 409);
  assert.equal((await read<Review>(demo.operatorCall("/" + id))).status, "uncertain");
  const retry = await demo.operatorCall("/" + id + "/reconcile", null);
  assert.equal(retry.status, 200);
  assert.equal((await read<Review>(retry)).external_id, 828);
  assert.equal(demo.posts.length, 1);
  assert.deepEqual((await read<Review>(demo.operatorCall("/" + id))).history.map(event => event.event), [
    "Webhook accepted", "Analysis started", "Draft ready", "Publication approved",
    "Publication unconfirmed", "Publication confirmed"
  ]);
});

test("leases analysis across concurrent HTTP requests and publishes the saved draft once", async t => {
  const demo = await fixture();
  let resume = () => {};
  demo.delayFiles(new Promise<void>(resolve => { resume = resolve; }));
  t.after(() => { resume(); return demo.close(); });
  const { id } = await read<{ id: string }>(demo.webhook());
  const path = "/" + id + "/analyze";
  const first = demo.operatorCall(path, null);
  for (let attempt = 0; demo.filesRequests() === 0 && attempt < 100; attempt++) await delay(10);
  assert.equal(demo.filesRequests(), 1);
  assert.equal((await read<Review>(demo.operatorCall("/" + id))).analyzing, true);
  assert.equal((await demo.operatorCall(path, null)).status, 409);
  resume();
  assert.equal((await first).status, 200);
  assert.equal(demo.filesRequests(), 1);
});

test("checks structured review model findings against a synthetic diff with a known boundary defect", async () => {
  const inputs = [{ file: "src/sum.ts", patch: "@@ -3,2 +3,2 @@\n const end = items.length;\n-for (let i = 0; i < end; i++) {\n+for (let i = 0; i <= end; i++) {" }];
  const known = { file: inputs[0]!.file, line: 4, evidence: "for (let i = 0; i <= end; i++) {",
    severity: "medium" as const, message: "The last iteration reads beyond the array." };
  const falseLocation = { ...known, line: 3 };
  const falseEvidence = { ...known, evidence: "return items[0];" };
  const advise = modelAdvisor({ key: "test-only", model: "mock-model", endpoint: "https://model.test" }, async (_, init) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.json_schema.strict, true);
    assert.equal(body.messages[0].role, "system");
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
      suggestions: [known, falseLocation, falseEvidence]
    }) } }] });
  });
  assert.deepEqual(supportedSuggestions(inputs, await advise(inputs)), [known]);
});
