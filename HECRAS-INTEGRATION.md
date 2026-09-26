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
HDF dataset access, with host-owned worker/decoder lifecycle. The version 1 API
was established through real-fixture checks. Existing NetCDF grid APIs are not necessarily sufficient
for unstructured HEC-RAS mesh connectivity and non-grid datasets.

The private `@geolibre/plugins` source export `./local-netcdf` is not an external
runtime service. Do not solve this by importing desktop registries into the plugin
or bundling another copy of the host's WASM/rendering stack.

HEC-RAS project semantics, dataset paths, UI and conformance adapters belong in the
plugin repository. Python extraction/publication remains in ras-commander/ras2cng.
DSS references are recognized but not decoded; model execution/editing is excluded.

The branch now exposes an optional version 1 local-Blob HDF session API, sharing
the existing host h5wasm runtime. Worker cancellation, plugin lifecycle cleanup,
bounded hyperslabs, expanded-chunk limits and decoded-value budgets keep raw HDF
access in the host; domain interpretation stays in the external plugin.

Validation includes 139 focused HDF, NetCDF and plugin lifecycle tests, real
HEC-RAS compound/geometry reads, browser-worker qualification, type checking and
targeted linting. Full frontend CI produced 9,961 passes, 13 failures and 3 skips.
All 13 failures reproduced against pristine base `12080a` with independently
installed dependencies on the same Windows/Node 22.17.1 environment: seven Bash
packaging cases and six component test files failing in the Vite load hook.
The full suite is not green on this environment; these baseline failures remain
separate from the passing focused checks.

A second optional capability persists bounded JSON at `layer.metadata.user[namespace]`
through `getLayerUserMetadata` and `setLayerUserMetadata`. Six focused tests verify
isolation, input limits and the actual host save/reopen/share-redaction path;
full desktop typechecking and touched-file lint/format passed.

The paired plugin first-pass implementation is `gpt-cmdr/geolibre-hecras` commit
`9db32ce` on the same branch name. It owns project metadata, HEC-RAS interpretation,
CRS conversion, GIS materialization and ras2cng manifest adaptation. An actual-host
reader/store/serializer check produced an 8,157,861-byte two-layer project with
3,359 features per layer, below the 10 MiB autosave cap. A fresh host-only process
reopened values and provenance without the plugin. Browser autosave invocation,
native Tauri and final installed-package UI requalification remain unverified;
see the plugin's VALIDATION.md for the precise evidence boundary.

This note is fork-local coordination material and should not be included
automatically in upstream PRs.
Create focused capability PR branches from current upstream main when ready;
follow upstream CONTRIBUTING.md and the applicable frontend/browser/CI gates.
