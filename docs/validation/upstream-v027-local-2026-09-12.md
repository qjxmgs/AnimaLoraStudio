# Local upstream v0.27.0 integration — 2026-09-12

## Scope

- Merge upstream/master `3d9d2e8` (v0.27.0) into local
  `feature/face-contour-mask`, preserving `37434f3` and `1278c13`.
- Origin remains qjxmgs; no push, PR, release, or remote protection changes.
- The original checkout remains on `863e60f`; its modified package lock and
  untracked files are not overwritten or stashed.

## Conflict decisions

- Retain upstream settings/credential storage, model selection and source controls,
  LyCORIS v4 pin, shared design components, and new training workspace.
- The upstream Auto mask header action adds grouped, unsaved rectangular edits.
  `FaceContourMaskPanel` retains explicit bitmap preview, selection, transactional
  Apply, provenance-safe replacement, and protected Undo in Training mask mode.
  Local translations are namespaced separately from the upstream quick workflow.
- Preserve bitmap decoding and CPU fallback, shared mask locks and journals;
  incorporate upstream durable failed/skipped outcomes and custom-model metadata.
- Keep distribution feature level 2 and all three updater guard layers. Existing
  accepted local ADR files stay unchanged; the index distinguishes local numbering.
- Isolate the HF download unit test from user-configured ModelScope preferences.

## Verification

- Full pytest in the independent worktree environment (LyCORIS 4.0.0):
  **3816 passed, 4 skipped**, 6 warnings, 187.71 seconds.
- Full frontend tests, including contour/quick-workflow isolation regressions:
  **994 passed**, 118 files.
- `npm run build`: ESLint, TypeScript and Vite passed; existing large-chunk advisory.
- Targeted Ruff checks passed; `pip check` passed; distribution checker confirms
  `auto_head_mask=2` and the self-update guard.
- Real production-build service at port 8766 uses only copied acceptance data in
  `tmp/sync-v027-browser/studio_data`. Health reports 0.27.0; both model catalog
  readiness flags are true. Schema-v2 contour proposals for project 2/version 2
  and their authorized PNG bitmap endpoint return successfully (HTTP 200).
- In-app browser navigation returned `net::ERR_BLOCKED_BY_CLIENT`; visual review
  of the merged UI could not be completed. Unit tests and HTTP checks are not
  represented as visual acceptance.
- No training or formal-dataset mask application was performed. The test service's
  settings migration ran on a copy, not on formal settings.

## Start and rollback boundary

Start `studio.bat` in `E:\AI\LoraTrainer\AnimaLoraStudio-auto-head-mask`, not the
unchanged original directory. This worktree has its own environment with pinned
LyCORIS 4.0.0 and ONNX Runtime DirectML. Model weights remain local and untracked.
Before the first normal startup, follow the v0.27 upgrade guide to back up formal
Studio data: upstream automatically migrates settings/credentials on startup.
Restoring code alone is not a safe rollback after that migration. The original
checkout and its LyCORIS 3.4 environment have been retained.
