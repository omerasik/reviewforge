# Implementation plan

The upstream Probot handler demonstrates GitHub event intake and file retrieval, then posts a review directly from the handler. ReviewForge owns signature verification, an idempotent delivery ledger and a separate draft and approval workflow. Its GitHub adapter retrieves bounded changed-file and check-run evidence. Per-repository rules classify risk, while optional model suggestions remain separate from observed check outcomes. Confirm publication in HTTP integration tests against a synthetic GitHub server.
