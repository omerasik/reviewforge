import { AppError } from "./domain.js";
import type { Review, Rules } from "./domain.js";
import { GitHubError } from "./github.js";
import type { GitHub } from "./github.js";
import { prepare } from "./review.js";
import type { Advises } from "./review.js";
import { maxAutoAttempts } from "./store.js";
import type { Store } from "./store.js";

export type AnalysisSetup = { store: Store; github: GitHub; repos: Record<string, Rules>; advise?: Advises };

export async function analyze(config: AnalysisSetup, review: Review, rules: Rules, automatic = false) {
  if (review.status !== "queued") return review;
  if (review.next_analysis_at) {
    const seconds = Math.ceil((new Date(review.next_analysis_at).getTime() - Date.now()) / 1000);
    if (seconds > 0) throw new AppError(429, "analysis_retry_wait", seconds);
  }
  const { token, attempt } = config.store.claimAnalysis(review.id, automatic);
  try {
    return config.store.saveDraft(review.id, token, await prepare(config.github, review, rules, config.advise));
  } catch (error) {
    const retry = error instanceof GitHubError && (error.ambiguous || error.retryAfter !== undefined);
    const delay = retry ? Math.max(attempt < maxAutoAttempts ? 2 ** attempt : 0, error.retryAfter ?? 0) : 0;
    config.store.failAnalysis(review.id, token, error instanceof AppError ? error.code : "analysis_error",
      delay ? Date.now() + delay * 1000 : -1);
    throw error;
  }
}

export function startAnalysisWorker(config: AnalysisSetup, interval = 1000) {
  const allowed = Object.keys(config.repos);
  let active: Promise<unknown> | undefined;
  const timer = setInterval(() => {
    if (active) return;
    let id: string | undefined;
    active = Promise.resolve().then(() => {
      const review = config.store.nextAnalysis(allowed);
      const rules = review && config.repos[review.repo];
      if (!review || !rules) return;
      id = review.id;
      return analyze(config, review, rules, true);
    }).catch(error => {
      if (error instanceof AppError && error.status < 500) return;
      console.error(JSON.stringify({ event: "queued_analysis_failed", review_id: id,
        code: error instanceof AppError ? error.code : "analysis_error" }));
    }).finally(() => { active = undefined; });
  }, interval);
  timer.unref();
  return async () => {
    clearInterval(timer);
    await active;
  };
}
