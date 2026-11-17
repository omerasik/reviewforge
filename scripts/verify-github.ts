import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { AppError, repoName } from "../src/domain.js";
import { GitHub } from "../src/github.js";
import { prepare } from "../src/review.js";

try {
  const { values } = parseArgs({ options: {
    repo: { type: "string" }, pr: { type: "string" }, "git-credentials": { type: "boolean" }
  } });
  const repo = repoName.parse(values.repo);
  const number = z.coerce.number().int().positive().parse(values.pr);
  let token = process.env.GITHUB_TOKEN;
  if (!token && values["git-credentials"]) {
    const result = execFileSync("git", ["credential", "fill"], {
      input: "protocol=https\nhost=github.com\n\n", encoding: "utf8", timeout: 15_000,
      stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }
    });
    token = result.split(/\r?\n/).find(line => line.startsWith("password="))?.slice(9);
  }
  if (!token) throw new Error("credentials_unavailable");
  const github = new GitHub(token, (url, init) => {
    if (init?.method !== "GET") throw new Error("read_only_verification");
    return fetch(url, init);
  });
  const current = await github.pull({ repo, number, sha: "0".repeat(40) });
  const draft = await prepare(github, { repo, number, sha: current.head.sha }, {
    maxFiles: 40, largeChange: 1000, criticalPrefixes: [".github/", "src/"], excludeModelPrefixes: []
  });
  console.log(JSON.stringify({ repo, number, sha: current.head.sha, files: draft.files.length,
    checks: draft.checks.length, bounded: draft.scopes.bounded, risk: draft.risk,
    model: draft.model, mode: "read-only", publication: "not attempted" }));
} catch (error) {
  console.error(error instanceof AppError ? error.code : "GitHub read verification failed; check credentials and arguments.");
  process.exitCode = 1;
}
