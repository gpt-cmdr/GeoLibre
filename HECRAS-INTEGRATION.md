# Project-aware HEC-RAS integration branch

This fork's `codex/project-aware-hecras` branch supports a separate external plugin:
[geolibre-hecras](https://github.com/gpt-cmdr/geolibre-hecras).

The canonical scope, milestones, acceptance criteria and technical debt ledger are
in its [roadmap](https://github.com/gpt-cmdr/geolibre-hecras/blob/codex/project-aware-hecras/ROADMAP.md).
The plugin repository is initially private. Locally it is the sibling
`../geolibre-hecras/ROADMAP.md` under CLB-Repos.

Base commit: `12080a1757149e1d06853619be026d153a46d292` (2026-09-26).

## Fork scope

Keep changes here small and general: external-plugin file intake and bounded
HDF dataset access, with host-owned worker/decoder lifecycle. Exact APIs follow
a real-fixture spike. Existing NetCDF grid APIs are not necessarily sufficient
for unstructured HEC-RAS mesh connectivity and non-grid datasets.

The private `@geolibre/plugins` source export `./local-netcdf` is not an external
runtime service. Do not solve this by importing desktop registries into the plugin
or bundling another copy of the host's WASM/rendering stack.

HEC-RAS project semantics, dataset paths, UI and conformance adapters belong in the
plugin repository. Python extraction/publication remains in ras-commander/ras2cng.
DSS references are recognized but not decoded; model execution/editing is excluded.

No application code is changed in this initial branch. This note is fork-local
coordination material and should not be included automatically in upstream PRs.
Create focused capability PR branches from current upstream main when ready;
follow upstream CONTRIBUTING.md and the applicable frontend/browser/CI gates.
