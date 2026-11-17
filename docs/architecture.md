# Architecture

The GitHub webhook endpoint verifies an HMAC of the original request bytes. In one SQLite transaction the service records the delivery, resolves the configured repository, and associates the event with a unique repository, pull request and commit. This prevents new deliveries for the same head from repeatedly creating drafts.

A polling worker claims queued reviews using a 45-second SQLite lease. Operators can also start analysis through the authenticated API. The same lease protects either entry point from concurrent processing. A retry deadline and attempt count persist across restarts. Recoverable GitHub failures use bounded backoff and honor the provider's retry window. Expired leases can be reclaimed up to the automatic attempt cap.

The GitHub adapter reads a bounded page of changed files and check runs, and checks that the same PR head is still open before saving the draft. Configured path prefixes and line thresholds classify the change. The stored draft contains change counts and check outcomes. Diff bytes are processed in memory. The optional model receives a smaller bounded subset, with separate file exclusions. A cited suggestion is retained only when its line and evidence match the inspected diff.

Publication requires a separate operator request with an explicit approval flag and the matching commit SHA. One conditional database write claims publication. Only that claimant sends a GitHub review with the COMMENT event and reviewed commit. Successful publication records the GitHub review ID. A known rejection releases the claim for a future explicit attempt. A network failure during submission keeps the state blocked for reconciliation, preventing a second write when GitHub may already have accepted the first one. Reconciliation searches for the unique review marker over at most three pages.

GitHub API requests have time and body limits and failures surface as stable operational codes. Check runs and model suggestions remain separate in JSON and in the published comment.
