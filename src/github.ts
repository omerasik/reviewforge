import { z } from "zod";
import { AppError, checkSchema, fileSchema, head } from "./domain.js";
import type { Pull } from "./domain.js";
import { responseJson } from "./io.js";

const reference = z.object({ state: z.string(), changed_files: z.number().int().nonnegative(), head: z.object({ sha: head }) });
const checks = z.object({ total_count: z.number().int().nonnegative(), check_runs: z.array(checkSchema).max(40) });
const reviewId = z.object({ id: z.number().int().positive() });
const postedReviews = z.array(z.object({ id: z.number().int().positive(), body: z.string().nullable(), commit_id: head }));

export class GitHubError extends AppError {
  constructor(httpStatus: number, code: string, public readonly ambiguous: boolean, retryAfter?: number) {
    super(httpStatus, code, retryAfter);
  }
}

export class GitHub {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  private async send<T>(path: string, schema: z.ZodType<T>, body?: object): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher("https://api.github.com/repos/" + path, {
        method: body ? "POST" : "GET",
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + this.token,
          "Content-Type": "application/json",
          "User-Agent": "ReviewForge",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: body ? JSON.stringify(body) : undefined
      });
    } catch {
      throw new GitHubError(502, "github_unreachable", true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      const remaining = response.headers.get("x-ratelimit-remaining");
      const retryHeader = response.headers.get("retry-after");
      if (response.status === 429 || (response.status === 403 && (remaining === "0" || retryHeader))) {
        const reset = Number(response.headers.get("x-ratelimit-reset"));
        const seconds = Number(retryHeader) || Math.ceil(reset - Date.now() / 1000) || 60;
        throw new GitHubError(503, "github_rate_limited", false, Math.max(1, Math.min(seconds > 0 ? seconds : 60, 3600)));
      }
      throw new GitHubError(502, "github_request_failed", response.status >= 500);
    }
    try {
      return schema.parse(await responseJson(response, 1_250_000));
    } catch {
      throw new GitHubError(502, "github_invalid_response", true);
    }
  }

  pull(pull: Pull) {
    return this.send(pull.repo + "/pulls/" + pull.number, reference);
  }

  files(pull: Pull, limit: number) {
    return this.send(pull.repo + "/pulls/" + pull.number + "/files?per_page=" + limit, z.array(fileSchema).max(limit));
  }

  checkRuns(pull: Pull) {
    return this.send(pull.repo + "/commits/" + pull.sha + "/check-runs?per_page=40", checks);
  }

  publish(pull: Pull, body: string) {
    return this.send(pull.repo + "/pulls/" + pull.number + "/reviews", reviewId,
      { event: "COMMENT", commit_id: pull.sha, body });
  }

  async lookup(pull: Pull, marker: string) {
    for (let page = 1; page <= 3; page += 1) {
      const options = "?per_page=30&page=" + page;
      const reviews = await this.send(pull.repo + "/pulls/" + pull.number + "/reviews" + options, postedReviews.max(30));
      const existing = reviews.find(review => review.commit_id === pull.sha && review.body?.includes(marker));
      if (existing || reviews.length < 30) return existing;
    }
    return undefined;
  }
}
