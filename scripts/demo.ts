import assert from "node:assert/strict";
import type { Review } from "../src/domain.js";
import { fixture, read, sha } from "./fixture.js";

const local = await fixture();
try {
  const response = await local.webhook();
  assert.equal(response.status, 202);
  const { id } = await read<{ id: string }>(response);
  const analyze = await local.operatorCall("/" + id + "/analyze", null);
  assert.equal(analyze.status, 200);
  const draft = await analyze.json();
  assert.equal(local.posts.length, 0);
  console.log(JSON.stringify({ draft }, null, 2));
  if (process.argv.includes("--approve")) {
    const approved = await local.operatorCall("/" + id + "/publish", { approve: true, sha });
    assert.equal(approved.status, 200);
    console.log(JSON.stringify({ published: (await read<Review>(approved)).external_id, mode: "synthetic" }));
  }
} finally {
  await local.close();
}
