# League Intel sync: end-to-end test

`run.sh` runs the real `index.html` in Chromium against the real Report Cards
API (`../Ddreportcards`): `api.py`, `chat_guard`, `intel_store` and its Lua,
executed by a real `redis-server` behind a small Upstash-compatible HTTP shim.
Pages are served under their real production and deploy-preview origins, so
the origin rules are the real ones.

Mocked: Sleeper data (owner ids 1000–1011) and `/chat` (AI synthesis). No
model is called, and nothing touches production.

```
DD_DIR=../Ddreportcards DD_PYTHON=/path/to/dd-venv/bin/python tests/e2e/run.sh
ONLY=concurrent ...            # run scenarios whose name starts with this
SHOTS=/tmp/shots ONLY=screenshots ...   # save screenshots of the intel UI
```

Requires a Ddreportcards environment with its locked dependencies installed,
`redis-server` on PATH, and Node with Playwright and Chromium.

The default suite (`python -m unittest discover -s tests`) does not run
this. It runs the stdlib structural checks in `tests/test_intel_sync.py`.

## Scenarios

| Scenario | What it proves |
|---|---|
| Legacy migration | Real pre-sync records upload correctly. The name is cleaned. An exact duplicate and a blank note collapse, leaving 2 notes. Oldest-first revisions. The breakdown covers the migrated notes. Invalid owner keys are ignored. The legacy store is kept. The chat prompt carries the result. A second device holding the same notes adds no duplicates. |
| Migration vs server data | A server name, or one deliberately cleared, is never overwritten. The rejected local value is kept, and "Use mine" restores it. |
| Interrupted upload | A failed PUT leaves the note pending locally. It survives a reload and lands exactly once. A re-sent id is idempotent. |
| 503 / offline | Nothing is merged and local intel is byte-identical. The note stays visible and the status says it will retry. It recovers. |
| 401 | Changes stay pending until the key is fixed, then save. |
| AI failure | The note is saved anyway and shown as outstanding. Re-synthesize folds it in. |
| Concurrent synthesis | Two devices race. The winner's breakdown stands, and the loser's note is kept and marked outstanding. Re-synthesize covers all notes. The busy state survives re-renders. |
| Name conflict | The server value wins, and the rejected value is preserved. |
| Independent fields | A name edit and a note plus breakdown from different devices both land. |
| Preview | Real intel is read. Edits stay local. Zero PUTs are sent. The banner is shown. The server returns 403 to a preview-origin write anyway. |
| Server wipe | The device re-uploads everything and says so. |
| Export / import | A fresh device restores from a file after a wipe, with ids preserved. A conflicting import is reported and not applied. A garbage file is rejected. |
| No key | Device-only, and nothing is sent. |
