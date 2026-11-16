import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./domain.js";
import type { Draft, Pull, Review } from "./domain.js";

type Row = Omit<Review, "draft" | "history" | "analyzing"> & {
  draft: string | null; history: string; analysis_until: number;
};

function readable(row: unknown): Review {
  const { analysis_until, draft, history, ...view } = row as Row;
  return { ...view, analyzing: analysis_until > Date.now(),
    draft: draft ? JSON.parse(draft) as Draft : null, history: JSON.parse(history) as Review["history"] };
}

const fields = "id, repo, number, sha, status, draft, external_id, created_at, approved_at, analysis_until, analysis_error, history";
const history = "json_insert(CASE WHEN json_array_length(history) >= 100 THEN json_remove(history, '$[0]') ELSE history END, '$[#]', json_object('event', ?, 'at', ?))";

export class Store {
  private readonly db: DatabaseSync;

  constructor(location = ":memory:") {
    if (location !== ":memory:") mkdirSync(dirname(resolve(location)), { recursive: true });
    this.db = new DatabaseSync(location);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        sha TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued','ready','publishing','published','uncertain')),
        draft TEXT,
        external_id INTEGER,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        UNIQUE (repo, number, sha)
      );
      CREATE INDEX IF NOT EXISTS reviews_recent_idx ON reviews (created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        review_id TEXT NOT NULL REFERENCES reviews (id)
      );
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = new Set(this.db.prepare("PRAGMA table_info(reviews)").all().map(column => column.name));
      if (!columns.has("analysis_token")) this.db.exec("ALTER TABLE reviews ADD COLUMN analysis_token TEXT");
      if (!columns.has("analysis_until")) this.db.exec("ALTER TABLE reviews ADD COLUMN analysis_until INTEGER NOT NULL DEFAULT 0");
      if (!columns.has("analysis_error")) this.db.exec("ALTER TABLE reviews ADD COLUMN analysis_error TEXT");
      if (!columns.has("history")) this.db.exec("ALTER TABLE reviews ADD COLUMN history TEXT NOT NULL DEFAULT '[]'");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      this.db.close();
      throw error;
    }
  }

  enqueue(id: string, hash: string, pull: Pull) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const delivered = this.db.prepare("SELECT hash, review_id FROM deliveries WHERE id = ?").get(id);
      if (delivered) {
        if (delivered.hash !== hash) throw new AppError(409, "delivery_conflict");
        this.db.exec("COMMIT");
        return { id: String(delivered.review_id), duplicate: true };
      }

      const inserted = this.db.prepare(`
        INSERT INTO reviews (id, repo, number, sha, status, created_at, history)
        VALUES (?, ?, ?, ?, 'queued', ?, json_array(json_object('event', 'Webhook accepted', 'at', ?)))
        ON CONFLICT (repo, number, sha) DO NOTHING RETURNING id
      `).get(randomUUID(), pull.repo, pull.number, pull.sha, new Date().toISOString(), new Date().toISOString());
      const existing = inserted ?? this.db.prepare("SELECT id FROM reviews WHERE repo = ? AND number = ? AND sha = ?")
        .get(pull.repo, pull.number, pull.sha);
      if (typeof existing?.id !== "string") throw new Error("review_insert_failed");
      this.db.prepare("INSERT INTO deliveries VALUES (?, ?, ?)").run(id, hash, existing.id);
      this.db.exec("COMMIT");
      return { id: existing.id, duplicate: !inserted };
    } catch (reason) {
      this.db.exec("ROLLBACK");
      throw reason;
    }
  }

  get(id: string): Review {
    const row = this.db.prepare(`SELECT ${fields} FROM reviews WHERE id = ?`).get(id);
    if (!row) throw new AppError(404, "review_not_found");
    return readable(row);
  }

  list(): Review[] {
    return this.db.prepare(`SELECT ${fields} FROM reviews ORDER BY created_at DESC, id DESC LIMIT 100`).all().map(readable);
  }

  claimAnalysis(id: string) {
    const token = randomUUID();
    const now = Date.now();
    const updated = this.db.prepare(`
      UPDATE reviews SET analysis_token = ?, analysis_until = ?, analysis_error = NULL, history = ${history}
      WHERE id = ? AND status = 'queued' AND analysis_until <= ?
    `).run(token, now + 45_000, "Analysis started", new Date(now).toISOString(), id, now);
    if (!updated.changes) throw new AppError(409, "analysis_in_progress");
    return token;
  }

  saveDraft(id: string, token: string, draft: Draft) {
    const updated = this.db.prepare(`
      UPDATE reviews SET draft = ?, status = 'ready', analysis_token = NULL, analysis_until = 0, history = ${history}
      WHERE id = ? AND status = 'queued' AND analysis_token = ? AND analysis_until > ?
    `).run(JSON.stringify(draft), "Draft ready", new Date().toISOString(), id, token, Date.now());
    if (!updated.changes) throw new AppError(409, "analysis_lease_expired");
    return this.get(id);
  }

  failAnalysis(id: string, token: string, code: string) {
    this.db.prepare(`
      UPDATE reviews SET analysis_token = NULL, analysis_until = 0, analysis_error = ?, history = ${history}
      WHERE id = ? AND status = 'queued' AND analysis_token = ?
    `).run(code, "Analysis failed", new Date().toISOString(), id, token);
  }

  claimPublication(id: string) {
    const now = new Date().toISOString();
    return Boolean(this.db.prepare(`
      UPDATE reviews SET status = 'publishing', approved_at = ?, history = ${history}
      WHERE id = ? AND status = 'ready'
    `).run(now, "Publication approved", now, id).changes);
  }

  finish(id: string, externalId: number) {
    this.db.prepare(`
      UPDATE reviews SET status = 'published', external_id = ?, history = ${history}
      WHERE id = ? AND status IN ('publishing', 'uncertain')
    `).run(externalId, "Publication confirmed", new Date().toISOString(), id);
    return this.get(id);
  }

  markProblem(id: string, uncertain: boolean) {
    this.db.prepare(`
      UPDATE reviews SET status = ?, approved_at = CASE WHEN ? = 1 THEN approved_at ELSE NULL END, history = ${history}
      WHERE id = ? AND status = 'publishing'
    `).run(uncertain ? "uncertain" : "ready", Number(uncertain),
      uncertain ? "Publication unconfirmed" : "Publication rejected", new Date().toISOString(), id);
  }

  close() {
    this.db.close();
  }
}
