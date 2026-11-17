# ReviewForge

ReviewForge drafts pull request reviews from changed files, repository rules and GitHub checks. The React dashboard shows draft evidence and review history. An operator can approve publication for the exact commit reviewed.

## Quick start

Use Node.js 22.14+ and npm.

```sh
npm ci
npm run demo
npm run demo -- --approve
npm run build
npm run demo -- --serve
```

The demo starts a local HTTP service, submits a signed synthetic PR event, prepares a review and prints it as JSON. With `--approve`, it also tests the publication contract using mocked GitHub responses. No real GitHub repository or AI account is required for either demo.

The `--serve` demo prints a loopback URL and synthetic operator token. Open the URL, connect, select the fixture pull request and choose **Analyze pull request**. Inspect policy findings, check results and model evidence. **Approve review** opens a confirmation for the reviewed commit. Publication goes to the synthetic fixture during this demo.

## Connect a repository

Copy `repositories.example.json` to `repositories.json`, add your permitted repositories, and configure the file path and credentials from `.env.example`. Inject credentials with your environment or secret manager. For GitHub, use an installation token or an appropriately restricted API credential with pull request and check access. Publication requires PR write access. Configure a GitHub pull-request webhook to deliver JSON to `/webhooks/github` using the same webhook secret. Serve external requests through a TLS endpoint.

```sh
npm run build
npm start
```

The default listener binds to `127.0.0.1:3040` and stores the review ledger under `data/`. Set `REPOSITORIES_FILE` to use a custom config and keep the webhook, operator and GitHub credentials distinct. Turn on model suggestions explicitly with `MODEL_API_KEY`, `MODEL_NAME` and an optional HTTPS `MODEL_ENDPOINT`. An opt-in model receives bounded diffs from configured paths. Project defaults make no model calls.

The deployed server analyzes queued pull requests automatically. SQLite stores the lease, attempt count and next eligible time. Transient GitHub errors use bounded exponential backoff and respect `Retry-After`. After three automatic attempts, an operator can retry from the dashboard when eligible. Set `AUTO_ANALYZE=false` for operator-triggered analysis.

## REST operations

| Route | Use |
| --- | --- |
| POST `/webhooks/github` | Verify GitHub's signature and enqueue or deduplicate a PR head. |
| GET `/api/reviews` | List up to 100 recent reviews for configured repositories. |
| GET `/api/repositories` | Read repository review policies. |
| GET `/api/reviews/{id}` | Inspect the draft, check results and publication status. |
| POST `/api/reviews/{id}/analyze` | Retrieve changed files and GitHub Checks, then store the draft. |
| POST `/api/reviews/{id}/publish` | Provide `{"approve":true,"sha":"<reviewed commit SHA>"}` to publish a COMMENT review. |
| POST `/api/reviews/{id}/reconcile` | Look for the existing GitHub review after an uncertain publication. |

All review routes require the operator bearer token. GitHub rate limits return HTTP 503 with a retry interval. If the PR changes or closes before publication, the old draft cannot be posted by that approval request. If a submission times out, use reconciliation before further action. The tooling holds ambiguous submissions and never retries them automatically.

## Engineering and verification

The TypeScript service uses Node HTTP, SQLite, and Zod. Repository rules define a file budget, line threshold, critical path prefixes and model exclusion prefixes. It retrieves up to the configured file limit and 40 check runs. Partial scope is visible in the draft. A Dockerfile is available for container builds. [Architecture](docs/architecture.md).

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm audit --audit-level=moderate
```

HTTP integration tests use a GitHub fixture. They cover signatures, authorization, delivery deduplication, automatic analysis and rate-limit recovery, stale heads, concurrent analysis and approval, and recovery after a dropped publication response. The model adapter checks structured findings against the examined line in the bounded diff. A synthetic case checks the filter using one correct and two unsupported suggestions. It measures evidence-filter behavior with a mocked model. This version uses one operator role and a SQLite ledger. The hosted webhook, real review publication and paid model require authorized configurations.

Original work includes the signed delivery ledger, repo-level policy, evidence and proposal format, commit-scoped approval and publication recovery. [Third-party notices](THIRD_PARTY_NOTICES.md) · [MIT license](LICENSE).
