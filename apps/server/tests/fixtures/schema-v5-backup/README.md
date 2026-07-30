# Preserved relational schema v5 backup fixture

This fixture freezes the relational v5 contract that shipped at commit
`b7ab799`. `schema.sql` is the v5 DDL plus one inert project, and
`manifest.json` is the matching backup manifest.

The production-process smoke test materializes these text fixtures into a real
SQLite backup before running the current verifier, restore command, and normal
server migration. Keep this fixture independent from the current backup writer
and current schema builder: compatibility tests must not regenerate it from a
newer database and then downgrade it.
