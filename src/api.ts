import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { z } from "zod";
import { AppError, head, webhook } from "./domain.js";
import type { Review, Rules } from "./domain.js";
import { GitHub, GitHubError } from "./github.js";
import { rawBody, secureMatch, value } from "./io.js";
import { ensureCurrent, marker, prepare, render } from "./review.js";
import type { Advises } from "./review.js";
import type { Store } from "./store.js";

type Setup = {
  webhookSecret: string;
  operatorToken: string;
  repos: Record<string, Rules>;
  store: Store;
  github: GitHub;
  advise?: Advises;
};

const approval = z.object({ approve: z.literal(true), sha: head }).strict();
const supported = new Set(["opened", "reopened", "synchronize", "ready_for_review"]);

const header = (message: IncomingMessage, key: string) => {
  const value = message.headers[key];
  return typeof value === "string" ? value : "";
};

export function service(config: Setup) {
  const { store, github } = config;

  async function delivery(request: IncomingMessage) {
    const body = await rawBody(request, 192 * 1024);
    const expected = "sha256=" + createHmac("sha256", config.webhookSecret).update(body).digest("hex");
    if (!secureMatch(header(request, "x-hub-signature-256"), expected)) throw new AppError(401, "invalid_signature");

    const headerId = z.uuid().safeParse(header(request, "x-github-delivery"));
    if (!headerId.success) throw new AppError(400, "invalid_delivery");
    if (header(request, "x-github-event") !== "pull_request") return { status: 200, body: { ignored: true } };

    const event = webhook.safeParse(value(body));
    if (!event.success) throw new AppError(422, "invalid_pull_request");
    if (!supported.has(event.data.action)) return { status: 200, body: { ignored: true } };
    const repo = event.data.repository.full_name.toLowerCase();
    if (!Object.hasOwn(config.repos, repo)) throw new AppError(403, "repository_not_allowed");

    const saved = store.enqueue(headerId.data, createHash("sha256").update(body).digest("hex"), {
      repo, number: event.data.number, sha: event.data.pull_request.head.sha
    });
    return { status: saved.duplicate ? 200 : 202, body: saved };
  }

  async function publish(review: Review, request: IncomingMessage) {
    const decision = approval.safeParse(value(await rawBody(request, 1024)));
    if (!decision.success || decision.data.sha !== review.sha) throw new AppError(422, "approval_required");
    if (review.status === "published") return review;
    if (review.status !== "ready" || !review.draft) throw new AppError(409, "review_not_ready");
    await ensureCurrent(github, review);
    if (!store.claimPublication(review.id)) throw new AppError(409, "publication_in_progress");
    try {
      const result = await github.publish(review, render(review, review.draft));
      return store.finish(review.id, result.id);
    } catch (error) {
      store.markProblem(review.id, !(error instanceof GitHubError) || error.ambiguous);
      throw error;
    }
  }

  async function route(request: IncomingMessage) {
    const method = request.method;
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (method === "GET" && path === "/health") return { status: 200, body: { status: "ok" } };
    if (method === "POST" && path === "/webhooks/github") return delivery(request);

    if (!secureMatch(header(request, "authorization"), "Bearer " + config.operatorToken)) {
      throw new AppError(401, "operator_required");
    }
    if (method === "GET" && path === "/api/reviews") return { status: 200, body: store.list() };

    const match = /^\/api\/reviews\/([^/]+)(?:\/(analyze|publish|reconcile))?$/.exec(path);
    const id = z.uuid().safeParse(match?.[1]);
    if (!id.success) throw new AppError(404, "route_not_found");
    const operation = match?.[2];
    const review = store.get(id.data);
    const rules = Object.hasOwn(config.repos, review.repo) ? config.repos[review.repo] : undefined;
    if (!rules) throw new AppError(403, "repository_not_allowed");

    if (method === "GET" && !operation) return { status: 200, body: review };
    if (method === "POST" && operation === "analyze") {
      const result = review.status === "queued" ? store.saveDraft(review.id,
        await prepare(github, review, rules, config.advise)) : review;
      return { status: 200, body: result };
    }
    if (method === "POST" && operation === "publish") return { status: 200, body: await publish(review, request) };
    if (method === "POST" && operation === "reconcile") {
      if (!["publishing", "uncertain"].includes(review.status)) throw new AppError(409, "no_uncertain_publication");
      const result = await github.lookup(review, marker(review));
      if (!result) throw new AppError(409, "publication_unconfirmed");
      return { status: 200, body: store.finish(review.id, result.id) };
    }
    throw new AppError(404, "route_not_found");
  }

  return createServer({ requestTimeout: 25_000, headersTimeout: 8_000 }, async (request, response) => {
    const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    try {
      const result = await route(request);
      response.writeHead(result.status, headers).end(JSON.stringify(result.body));
    } catch (reason) {
      const error = reason instanceof AppError ? reason : new AppError(500, "internal_error");
      if (!(reason instanceof AppError)) console.error(JSON.stringify({ event: error.code }));
      response.writeHead(error.status, { ...headers, ...(error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) })
        .end(JSON.stringify({ error: error.code }));
    }
  });
}
