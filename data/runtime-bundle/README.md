# Portable exact-routing runtime

`manifest.json` lists checksummed gzip streams, split into parts below GitHub's per-file limit. The installer verifies **all** parts before writing any resource. No Git LFS or external data download is required.

- `roads`: actual Moscow OSM/Valhalla graph (1,816 tiles), matching the existing routing engine. Original graph timestamp and SHA-256 are retained. This is routing data, not a replacement basemap.
- `transit-index`: SQL source export of the canonical public timetable and measured walk transfers. The installer constructs a **new** read-only routing database; it never copies an operational SQLite database. Table counts, compressed/uncompressed digests and integrity are verified.
- `transit-sources`: original GTFS text files and metro schema. The already versioned railway archive is installed by its existing verified installer.

No operational shifts, customer history, dispatch receipts, credentials, paid request usage ledger or fabricated route responses are included. All new/unseen routes still use real Valhalla and the exact validator. Restored routing data are independent of `building_models` and the operational database.

Provenance and source terms: `manifest.json`, `data/transit/moscow_2026-08-17.manifest.json`, `THIRD_PARTY_LICENSES.md`.

Use `docker compose -f compose.complete.yaml up --build -d` from the repository root. Advanced native installs can run `python tools/install_runtime_bundle.py`; they still need a configured real routing service and the normal Node/Python dependencies.
