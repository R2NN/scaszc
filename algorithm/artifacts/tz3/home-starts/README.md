# Verified scenario home starts

Two existing engineers start at scenario-only registry addresses on 2026-08-17.
The original roster, skills, shifts, transport, equipment, job durations and stock
constraints are retained. This is not real residential information.

`input.json.gz` is the full UI input; `initial-exact.json.gz` is the independently
validated full-day plan. `manifest.json` binds their bytes, the dataset, and the
original input fingerprint used to select fresh sessions safely. `dataset/` is
the original canonical dataset with two start-office assignments and their
provenance added. Its byte checksums are protected by `.gitattributes`.

Coverage increases from 203/205 to 204/205. See
`docs/home-start-scenario.md` and `algorithm/tools/repair_home_start_plan.py` for
the actual insertion search, comparison and reproduction command.
