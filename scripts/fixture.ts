import { createHmac, randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { service } from "../src/api.js";
import { GitHub } from "../src/github.js";
import { Store } from "../src/store.js";

export const sha = "a".repeat(40);
export const repoName = "example/project";
const secret = "reviewforge-synthetic-webhook";
export const operator = "reviewforge-synthetic-operator";
const id = 828;

export async function read<T>(response: Response | Promise<Response>): Promise<T> {
  return (await (await response).json()) as T;
}

export async function fixture(options: { staticDir?: string } = {}) {
  const store = new Store();
  const posts: { body: string; commit_id: string }[] = [];
  let current = sha;
  let rateLimited = false;
  let losePostResponse = false;
  let filesRequests = 0;
  let pendingFiles: Promise<void> | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== "https://api.github.com") throw new Error("Unexpected GitHub address");
    if (url.pathname.endsWith("/files")) {
      filesRequests += 1;
      await pendingFiles;
      if (rateLimited) return Response.json({}, { status: 429, headers: { "Retry-After": "21" } });
      return Response.json([
        { filename: ".github/workflows/check.yml", status: "modified", additions: 10, deletions: 3, patch: "@@\n+name: Verify" },
        { filename: "src/normalize.ts", status: "modified", additions: 18, deletions: 2, patch: "@@ -8,1 +8,1 @@\n-return input\n+return input.trim()" }
      ]);
    }
    if (url.pathname.endsWith("/check-runs")) return Response.json({
      total_count: 2, check_runs: [{ name: "unit tests", status: "completed", conclusion: "failure" },
        { name: "typecheck", status: "completed", conclusion: "success" }]
    });
    if (url.pathname.endsWith("/reviews")) {
      if (init?.method === "POST") {
        const command = JSON.parse(String(init.body));
        if (command.event !== "COMMENT") return Response.json({}, { status: 422 });
        posts.push(command);
        if (losePostResponse) throw new Error("simulated dropped response");
        return Response.json({ id }, { status: 201 });
      }
      return Response.json(posts.map(post => ({ ...post, id })));
    }
    return Response.json({ state: "open", head: { sha: current }, changed_files: 3 });
  };
  const app = service({
    staticDir: options.staticDir,
    webhookSecret: secret, operatorToken: operator, store, github: new GitHub("fixture-only", fetcher),
    repos: {
      [repoName]: { maxFiles: 2, largeChange: 200, criticalPrefixes: [".github/workflows/"],
        excludeModelPrefixes: [".github/"] }
    },
    advise: async candidates => candidates.map(input => ({
      file: input.file, severity: "low", message: "Add a test for blank input.", line: 8, evidence: "return input.trim()"
    }))
  });
  app.listen(0, "127.0.0.1");
  await once(app, "listening");
  const base = "http://127.0.0.1:" + (app.address() as AddressInfo).port;

  function webhook(options: { event?: string; delivery?: string; githubRepo?: string; pullHead?: string; signed?: boolean } = {}) {
    const raw = JSON.stringify({
      action: "opened", number: 16,
      repository: { full_name: options.githubRepo ?? repoName },
      pull_request: { head: { sha: options.pullHead ?? sha } }
    });
    const signature = createHmac("sha256", options.signed === false ? "wrong" : secret).update(raw).digest("hex");
    return fetch(base + "/webhooks/github", {
      method: "POST", body: raw,
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": "sha256=" + signature,
        "X-GitHub-Delivery": options.delivery ?? randomUUID(), "X-GitHub-Event": options.event ?? "pull_request" }
    });
  }

  function operatorCall(path = "", body?: object | null, authorized = true) {
    return fetch(base + "/api/reviews" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(authorized ? { Authorization: "Bearer " + operator } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  }

  return {
    webhook, operatorCall, posts, base,
    filesRequests: () => filesRequests,
    delayFiles: (value: Promise<void>) => { pendingFiles = value; },
    setHead: (value: string) => { current = value; },
    setRateLimited: () => { rateLimited = true; },
    losePostResponse: () => { losePostResponse = true; },
    async close() {
      await new Promise<void>((resolve, reject) => app.close(error => error ? reject(error) : resolve()));
      store.close();
    }
  };
}
