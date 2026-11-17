import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Draft, Review } from "../src/domain.js";
import { GitHub } from "../src/github.js";
import { modelAdvisor, prepare, supportedSuggestions } from "../src/review.js";
import { Store } from "../src/store.js";
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
  assert.equal((await demo.operatorCall("/" + next.id + "/analyze", null)).status, 429);
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
  assert.deepEqual(supportedSuggestions(inputs, [{ file: known.file, severity: "high", message: "No evidence" }]), []);
});

test("excludes renamed secrets from model input and classifies failed checks as high risk", async () => {
  const patch = "@@ -1 +1 @@\n-old\n+new";
  const github = new GitHub("fixture-only", async input => {
    const url = String(input);
    if (url.includes("/files?")) return Response.json([
      { filename: "notes.txt", previous_filename: ".env.production", status: "renamed", additions: 1, deletions: 1, patch },
      { filename: "src/normal.ts", status: "modified", additions: 1, deletions: 1, patch }
    ]);
    if (url.includes("/check-runs?")) return Response.json({ total_count: 1,
      check_runs: [{ name: "tests", status: "completed", conclusion: "failure" }] });
    return Response.json({ state: "open", head: { sha }, changed_files: 2 });
  });
  const draft = await prepare(github, { repo: "example/project", number: 16, sha }, {
    maxFiles: 10, largeChange: 200, criticalPrefixes: [], excludeModelPrefixes: []
  }, async candidates => {
    assert.deepEqual(candidates.map(candidate => candidate.file), ["src/normal.ts"]);
    return [];
  });
  assert.equal(draft.risk, "high");
  assert.deepEqual(draft.rules, []);
  assert.equal(draft.checks[0]?.conclusion, "failure");
});

test("persists analysis fencing and interrupted publication across database reopen", async t => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const directory = await mkdtemp(join(tmpdir(), "reviewforge-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "reviews.db");
  const first = new Store(path);
  const { id } = first.enqueue(randomUUID(), "digest", { repo: "example/project", number: 16, sha });
  const old = first.claimAnalysis(id, true);
  first.close();
  const next = new Store(path);
  try {
    assert.throws(() => next.claimAnalysis(id, true), /analysis_unavailable/);
    now += 46_000;
    const replacement = next.claimAnalysis(id, true);
    const draft: Draft = { risk: "low", scopes: { files: 0, checks: 0, bounded: false },
      rules: [], files: [], checks: [], suggestions: [], model: "disabled" };
    assert.throws(() => next.saveDraft(id, old.token, draft), /analysis_lease_expired/);
    next.saveDraft(id, replacement.token, draft);
    assert.equal(next.claimPublication(id), true);
  } finally { next.close(); }
  const reopened = new Store(path);
  try {
    assert.equal(reopened.get(id).status, "publishing");
    assert.equal(reopened.claimPublication(id), false);
    assert.equal(reopened.finish(id, 828).status, "published");
    assert.equal(reopened.get(id).history.filter(entry => entry.event === "Publication approved").length, 1);
  } finally { reopened.close(); }
});

test("automatically analyzes a queued webhook, honors backoff and waits for publication approval", async t => {
  const demo = await fixture({ autoAnalyze: true, transientFailure: true });
  t.after(() => demo.close());
  const { id } = await read<{ id: string }>(demo.webhook());
  let review = await read<Review>(demo.operatorCall("/" + id));
  for (let attempt = 0; review.analysis_error === null && attempt < 100; attempt++) {
    await delay(20);
    review = await read<Review>(demo.operatorCall("/" + id));
  }
  assert.equal(review.analysis_error, "github_rate_limited");
  assert.equal(review.analysis_attempts, 1);
  assert.ok(review.next_analysis_at);
  assert.equal(demo.filesRequests(), 1);
  for (let attempt = 0; review.status !== "ready" && attempt < 200; attempt++) {
    await delay(25);
    review = await read<Review>(demo.operatorCall("/" + id));
  }
  assert.equal(review.status, "ready");
  assert.equal(review.analysis_attempts, 2);
  assert.equal(review.next_analysis_at, null);
  assert.equal(review.draft?.checks.length, 2);
  assert.equal(demo.posts.length, 0);
  assert.equal((await demo.operatorCall("/" + id + "/publish", { approve: true, sha })).status, 200);
  assert.equal(demo.posts.length, 1);
});

test("reclaims expired analysis leases, stops automatically at the cap and permits operator retry", t => {
  let now = Date.parse("2026-11-17T13:00:00Z");
  t.mock.method(Date, "now", () => now);
  const store = new Store();
  t.after(() => store.close());
  const repo = "example/project";
  const { id } = store.enqueue(randomUUID(), "event-digest", { repo, number: 16, sha });
  assert.equal(store.nextAnalysis(["other/project"]), undefined);
  for (let attempt = 1; attempt <= 3; attempt++) {
    assert.equal(store.nextAnalysis([repo])?.id, id);
    assert.equal(store.claimAnalysis(id, true).attempt, attempt);
    assert.equal(store.nextAnalysis([repo]), undefined);
    now += 46_000;
  }
  assert.equal(store.nextAnalysis([repo]), undefined);
  assert.equal(store.get(id).analysis_error, "analysis_lease_exhausted");
  assert.equal(store.claimAnalysis(id, false).attempt, 4);
});
