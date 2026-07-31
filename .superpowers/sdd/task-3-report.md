DONE: Stage 7 Task 3 complete
Summary: Added strict success/failure child envelopes with canonical redacted messages.
Summary: Typed unsafe, unreadable, required, protocol-invalid, and retryable infrastructure paths.
Summary: SQLite and aggregate retries/terminal rows persist the caller's stable reason identically.
Files: audit protocol/engine/executor/process, job service/transitions/repositories, focused tests.
Tests: focused 53 pass; full server 523 pass.
Tests: server typecheck, Biome check ., and git diff --check pass.
Commit: fix: classify artifact audit worker failures
Risks: Bun 1.3.14 exposes maxBuffer overflow by killed output, so classification requires observed stdout over the protocol limit; generic failures remain retryable.
Review: Raw readers cap stdout/stderr, kill on overflow, await exit, and decode UTF-8 fatally.
Review: Process-only nested schemas are deep-strict while historic shared schemas stay unchanged.
Review: Sync known inspection faults keep safe AUDIT_FAILED 409; unknown faults stay generic 500.
Tests: review focused 77 pass; full server 531 pass; typecheck/Biome/diff-check pass.
Review commit: fix: harden artifact audit process boundaries
