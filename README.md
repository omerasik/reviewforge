# ReviewForge

ReviewForge drafts pull request reviews from changed-file metadata, repository rules and GitHub check runs. An operator can inspect the draft and explicitly approve a comment on the exact commit reviewed. The project exposes a REST API and a reproducible synthetic demo.

## Quick start

Use Node.js 22.14+ and npm.

```sh
npm ci
npm run demo
npm run demo -- --approve
```

The demo starts a local HTTP service, submits a signed synthetic PR event, prepares a review and prints it as JSON. With `--approve`, it also tests the publication contract using mocked GitHub responses. No real GitHub repository or AI account is required for either demo.

## Connect a repository

Copy `repositories.example.json` to `repositories.json`, add your permitted repositories, and configure the file path and credentials from `.env.example`. Inject credentials with your environment or secret manager. For GitHub, use an installation token or an appropriately restricted API credential with pull request and check access. Publication requires PR write access. Configure a GitHub pull-request webhook to deliver JSON to `/webhooks/github` using the same webhook secret. Serve external requests through a TLS endpoint.

```sh
npm run build
npm start
```

The default listener binds to `127.0.0.1:3040` and stores the review ledger under `data/`. Set `REPOSITORIES_FILE` to use a custom config and keep the webhook, operator and GitHub credentials distinct. Turn on model suggestions explicitly with `MODEL_API_KEY`, `MODEL_NAME` and an optional HTTPS `MODEL_ENDPOINT`. An opt-in model receives bounded diffs from configured paths. Project defaults make no model calls.

## REST operations

| Route | Use |
| --- | --- |
| POST `/webhooks/github` | Verify GitHub's signature and enqueue or deduplicate a PR head. |
| GET `/api/reviews` | List up to 100 recent reviews. |
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

HTTP integration tests mock GitHub. They cover signatures, authorization, duplicate delivery and head detection, rate limiting, stale heads, concurrent approval, and recovery after a dropped publication response. The hosted GitHub webhook and paid model are opt-in integrations. This version uses one operator role, one database and bounded review reconciliation. A reconciliation result may require inspection in GitHub on very large PR histories. The built-in SQLite module is experimental in Node.js 22.14.

Original work includes the signed delivery ledger, repo-level policy, evidence and proposal format, commit-scoped approval and publication recovery. [Third-party notices](THIRD_PARTY_NOTICES.md) · [MIT license](LICENSE).
