import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "./domain.js";
import type { Draft, Pull, Review } from "./domain.js";

type Row = Omit<Review, "draft"> & { draft: string | null };

function readable(row: unknown): Review {
  const view = row as Row;
  return { ...view, draft: view.draft ? JSON.parse(view.draft) as Draft : null };
}

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
        INSERT INTO reviews (id, repo, number, sha, status, created_at)
        VALUES (?, ?, ?, ?, 'queued', ?)
        ON CONFLICT (repo, number, sha) DO NOTHING RETURNING id
      `).get(randomUUID(), pull.repo, pull.number, pull.sha, new Date().toISOString());
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
    const row = this.db.prepare("SELECT * FROM reviews WHERE id = ?").get(id);
    if (!row) throw new AppError(404, "review_not_found");
    return readable(row);
  }

  list(): Review[] {
    return this.db.prepare("SELECT * FROM reviews ORDER BY created_at DESC, id DESC LIMIT 100").all().map(readable);
  }

  saveDraft(id: string, draft: Draft) {
    this.db.prepare("UPDATE reviews SET draft = ?, status = 'ready' WHERE id = ? AND status = 'queued'")
      .run(JSON.stringify(draft), id);
    return this.get(id);
  }

  claimPublication(id: string) {
    return Boolean(this.db.prepare(`
      UPDATE reviews SET status = 'publishing', approved_at = ?
      WHERE id = ? AND status = 'ready'
    `).run(new Date().toISOString(), id).changes);
  }

  finish(id: string, externalId: number) {
    this.db.prepare(`
      UPDATE reviews SET status = 'published', external_id = ?
      WHERE id = ? AND status IN ('publishing', 'uncertain')
    `).run(externalId, id);
    return this.get(id);
  }

  markProblem(id: string, uncertain: boolean) {
    this.db.prepare(`
      UPDATE reviews SET status = ?, approved_at = CASE WHEN ? = 1 THEN approved_at ELSE NULL END
      WHERE id = ? AND status = 'publishing'
    `).run(uncertain ? "uncertain" : "ready", Number(uncertain), id);
  }

  close() {
    this.db.close();
  }
}
