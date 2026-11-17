import assert from "node:assert/strict";
import type { Review } from "../src/domain.js";
import { fixture, operator, read, sha } from "./fixture.js";

const serve = process.argv.includes("--serve");
const local = await fixture({ staticDir: serve ? "web/dist" : undefined });
try {
  const response = await local.webhook();
  assert.equal(response.status, 202);
  const { id } = await read<{ id: string }>(response);
  if (serve) {
    console.log(JSON.stringify({ url: local.base, operatorToken: operator, mode: "synthetic" }));
    await new Promise<void>(resolve => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  } else {
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
  }
} finally {
  await local.close();
}
