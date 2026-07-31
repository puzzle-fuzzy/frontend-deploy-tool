DONE: Stage 7 Task 3 complete
Summary: Added strict success/failure child envelopes with canonical redacted messages.
Summary: Typed unsafe, unreadable, required, protocol-invalid, and retryable infrastructure paths.
Summary: SQLite and aggregate retries/terminal rows persist the caller's stable reason identically.
Files: audit protocol/engine/executor/process, job service/transitions/repositories, focused tests.
Tests: focused 53 pass; full server 523 pass.
Tests: server typecheck, Biome check ., and git diff --check pass.
Commit: fix: classify artifact audit worker failures
Risks: Bun 1.3.14 exposes maxBuffer overflow by killed output, so classification requires observed stdout over the protocol limit; generic failures remain retryable.
