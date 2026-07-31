# Preserved relational schema v5 backup fixture

This fixture freezes the relational v5 contract that shipped at commit
`b7ab799`. `schema.sql` is the v5 DDL plus one inert project, and
`manifest.json` is the matching backup manifest.

The production-process smoke test materializes these text fixtures into a real
SQLite backup before running the current verifier, restore command, and normal
server migration. Keep this fixture independent from the current backup writer
and current schema builder: compatibility tests must not regenerate it from a
newer database and then downgrade it.

The current proof is intentionally backup-path focused: `verify` runs the exact
production v5 -> v7 relational migrations and domain hydrator on a disposable
copy, `restore --force` installs the unchanged v5 snapshot, and a subsequently
spawned production server performs normal startup migration to v7. Generated
v6 and current-v7 corruption/domain coverage lives in the focused backup
service tests rather than being baked into this frozen fixture.
