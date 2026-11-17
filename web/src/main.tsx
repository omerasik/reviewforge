import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { createRoot } from "react-dom/client";
import type { Review, Rules } from "../../src/domain.js";
import "./style.css";

const states: Record<Review["status"], string> = {
  queued: "Queued", ready: "Ready for approval", publishing: "Publishing",
  published: "Published", uncertain: "Needs reconciliation"
};
const time = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

async function api<T>(route: string, token: string, action?: object | null, cancel?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(45_000);
  const response = await fetch("/api/" + route, {
    method: action === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer " + token, ...(action ? { "Content-Type": "application/json" } : {}) },
    body: action ? JSON.stringify(action) : undefined,
    signal: cancel ? AbortSignal.any([cancel, deadline]) : deadline
  });
  const body = await response.json();
  if (response.ok) return body as T;
  const retry = response.headers.get("Retry-After");
  throw new Error(retry ? "GitHub rate limited the request. Try again in " + retry + " seconds."
    : typeof body.error === "string" ? body.error.replaceAll("_", " ") : "The request failed.");
}

function Status({ review }: { review: Review }) {
  return <span className={"status " + review.status}>{review.analyzing ? "Analyzing" : states[review.status]}</span>;
}

function Findings({ draft }: { draft: NonNullable<Review["draft"]> }) {
  return <>
    <p className="summary"><span className={"status " + draft.risk}>{draft.risk} risk</span>
      {draft.files.length} of {draft.scopes.files} files · {draft.checks.length} of {draft.scopes.checks} checks
    </p>
    <div className="evidence">
      <section><h3>Policy findings</h3>{draft.rules.length ? <ul>{draft.rules.map(rule => <li key={rule}>{rule}</li>)}</ul> : <p>No policy findings.</p>}</section>
      <section><h3>GitHub checks</h3>{draft.checks.length ? <ul>{draft.checks.map((check, i) =>
        <li key={i}><strong>{check.name}</strong> · {check.conclusion ?? check.status}</li>)}</ul> : <p>No GitHub checks returned.</p>}</section>
    </div>
    <section className="findings"><h3>Model suggestions</h3>{draft.suggestions.length ? draft.suggestions.map((item, i) =>
      <article key={i}><strong>{item.file}{item.line ? ":" + item.line : ""} · {item.severity}</strong>
        <p>{item.message}</p>{item.evidence && <pre>{item.evidence}</pre>}</article>) :
      <p>{draft.model === "unavailable" ? "The model was unavailable." : "No suggestions in this draft."}</p>}</section>
    <details><summary>Inspected files</summary><ul>{draft.files.map(file =>
      <li key={file.filename}>{file.filename} · +{file.additions} / −{file.deletions}</li>)}</ul></details>
  </>;
}

function App() {
  const [token, setToken] = useState("");
  const [credential, setCredential] = useState("");
  const [reviews, setReviews] = useState<Review[]>([]);
  const [repositories, setRepositories] = useState<[string, Rules][]>([]);
  const [repository, setRepository] = useState("");
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [approval, setApproval] = useState("");
  const list = repository ? reviews.filter(review => review.repo === repository) : reviews;
  const current = list.find(review => review.id === selected) ?? list[0];
  const policy = repositories.find(([name]) => name === repository)?.[1];

  useEffect(() => {
    if (!token || busy) return;
    const controller = new AbortController();
    let waiting = false;
    const timer = setInterval(async () => {
      if (waiting) return;
      waiting = true;
      try {
        const list = await api<Review[]>("reviews", token, undefined, controller.signal);
        if (!controller.signal.aborted) setReviews(list);
      } catch {
        return;
      } finally {
        waiting = false;
      }
    }, 3000);
    return () => { clearInterval(timer); controller.abort(); };
  }, [token, busy]);

  async function refresh(value: string) {
    const [list, repos] = await Promise.all([
      api<Review[]>("reviews", value), api<[string, Rules][]>("repositories", value)
    ]);
    setReviews(list);
    setRepositories(repos);
  }

  async function run(label: string, operation: () => Promise<void>) {
    setBusy(label);
    setError("");
    try { await operation(); }
    catch (reason) { setError((reason as Error).message); }
    finally { setBusy(""); }
  }

  function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = credential.trim();
    setCredential("");
    void run("Connecting", async () => { await refresh(value); setToken(value); });
  }

  function change(operation: "analyze" | "publish" | "reconcile", review: Review) {
    const data = operation === "publish" ? { approve: true, sha: review.sha } : null;
    setApproval("");
    void run({ analyze: "Analyzing", publish: "Publishing", reconcile: "Reconciling" }[operation], async () => {
      try { await api("reviews/" + review.id + "/" + operation, token, data); }
      finally { await refresh(token).catch(() => undefined); }
    });
  }

  return <><header className="top"><div className="brand">ReviewForge</div><span>Pull request reviews</span>
    {token && <button disabled={!!busy} onClick={() => {
      setToken(""); setReviews([]); setRepositories([]); setRepository(""); setSelected(""); setError(""); setApproval("");
    }}>Sign out</button>}
  </header>
  <main>
    <div className="heading"><div><h1>Review queue</h1><p>Inspect incoming pull requests and approve a review for the commit you examined.</p></div>
      {token && <button disabled={!!busy} onClick={() => void run("Refreshing", () => refresh(token))}>Refresh</button>}</div>
    {error && <p className="error" role="alert">{error}</p>}
    {busy && <output className="notice">{busy}…</output>}
    {!token ? <form className="panel login" onSubmit={signIn}>
      <h2>Operator access</h2><label>Operator token<input type="password" autoComplete="off" required value={credential}
        onChange={event => setCredential(event.target.value)} /></label>
      <button className="primary" disabled={!!busy}>Connect</button>
    </form> : <div className="workspace">
      <aside className="panel">
        <div className="filters"><label>Repository<select value={repository} onChange={event => {
          setRepository(event.target.value); setApproval("");
        }}><option value="">All configured repositories</option>{repositories.map(([name]) => <option key={name}>{name}</option>)}</select></label>
        {policy && <small>File budget {policy.maxFiles}</small>}</div>
        <nav aria-label="Pull requests">{list.length ? list.map(review => <button className="row" key={review.id}
          aria-pressed={current?.id === review.id} onClick={() => { setSelected(review.id); setApproval(""); }}>
          <strong>{review.repo} #{review.number}</strong><small>{review.sha.slice(0, 8)} · {time.format(new Date(review.created_at))}</small>
          <Status review={review} /></button>) : <p className="empty">Signed webhook events appear here.</p>}</nav>
      </aside>
      <section className="panel detail" aria-label="Review details">{current ? <>
        <div className="detail-heading"><div><h2>{current.repo} #{current.number}</h2>
          <code className="sha">{current.sha}</code></div><Status review={current} /></div>
        {current.analysis_error && <p className="error">Last analysis failed · {current.analysis_error.replaceAll("_", " ")}</p>}
        {current.next_analysis_at && <p>Retry eligible at {time.format(new Date(current.next_analysis_at))}</p>}
        {current.status === "queued" && <button className="primary" disabled={!!busy || current.analyzing || !!current.next_analysis_at}
          onClick={() => change("analyze", current)}>{current.analysis_error ? "Retry analysis" : "Analyze pull request"}</button>}
        {current.draft && <Findings draft={current.draft} />}
        {current.status === "ready" && (approval === current.id ?
          <section className="approval"><p>Publish a GitHub review on commit <code>{current.sha.slice(0, 12)}</code>?</p>
            <button disabled={!!busy} onClick={() => setApproval("")}>Cancel</button>{" "}
            <button className="primary" disabled={!!busy} onClick={() => change("publish", current)}>Confirm publication</button></section> :
          <button className="primary" disabled={!!busy} onClick={() => setApproval(current.id)}>Approve review</button>)}
        {(current.status === "uncertain" || current.status === "publishing") && <button disabled={!!busy} onClick={() => change("reconcile", current)}>Reconcile publication</button>}
        {current.external_id !== null && <p>GitHub review {current.external_id}</p>}
        <section><h3>Review history</h3>{current.history.length ? <ol className="history">{current.history.map((value, i) =>
          <li key={i}>{value.event}<time dateTime={value.at}>{time.format(new Date(value.at))}</time></li>)}</ol> : <p>No stored history for this review.</p>}</section>
      </> : <p className="empty">Select an incoming pull request.</p>}</section>
    </div>}
  </main></>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Dashboard root missing.");
createRoot(root).render(<App />);
