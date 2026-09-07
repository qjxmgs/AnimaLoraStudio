# Face-contour local acceptance — 2026-09-07

This is local-only validation, not a release or an approval to batch-apply masks
to the original dataset. No training was started.

## Model preparation

The pinned 6,020,644-byte checkpoint passed SHA-256 validation. The independent
converter produced a 11,582,576-byte static FP32 ONNX model (opset 17), SHA-256
`3cbb25396b49c8ec2122af3b8378efd7fcee8ba49fa3837421b4fa72aa5213ce`.
Three seeded raw PyTorch/ONNX comparisons passed `rtol=atol=0.002`; maximum absolute
prediction error was 0.000824 and prototype error 0.0000302. Versions and parameters
are recorded in local `models/preprocess/face_segmenter/ready.json`.

Real inference used DirectML. A real head crop also passed CPU/DirectML raw-output
comparison at the same tolerance; both decoded instance masks agreed on every
pixel. CUDA execution was not tested: the installed ONNX Runtime exposes DirectML
and CPU, not CUDA. The main Studio environment received no new packages.

## Project 2 / version ID 2 (label v1), copies only

The opt-in `tools/validate_face_contour_local.py` utility created an isolated DB,
training-set copy and relocated proposal/application history. It detected 21
candidate regions in 19 of 22 images. Three images had no usable face result
(one without a head location, two without face segmentation). No fallback box
was generated. All source images, captions and masks matched their original
SHA-256 inventory after the copy workflow.

The copied workflow exercised individual deselection, 19 provenance-safe
replacements, undo, reapplication, manual repair and refusal to undo after manual
modification. The existing training loader read all 22 samples, including all 21
existing/generated mask sidecars as valid weights in [0, 1]. The remaining sample
has no mask and correctly returns `None` (normal learning).

Head-crop contact sheets were visually reviewed. The major rectangle overreach
into hair, neck and shoulders is removed on most images. This dataset does **not**
pass unattended quality acceptance: candidate counts are not true-face counts.
Ear/accessory false positives, partial faces under occlusion, extra fragments,
and some fringe/neck leakage remain. In the report's stable image order, cases
1, 7, 10, 17 and 20 especially need cancellation or brush/eraser repair; cases
3, 8 and 14 need manual handling. Review every remaining image too: no pixel-level
ground-truth annotations were provided, so no IoU/accuracy score is claimed.

Local reports and contact sheets are ignored under
`tmp/face-contour-acceptance-verified/`; neither dataset nor weights are committed.
The utility can be rerun with a **new** output directory. Its application checks
operate only on the isolated copies, not the original train directory.

## Browser and regressions

The production-built service was opened in the in-app browser using the isolated
copy. Checked actual orange contour overlays, individual deselection, head-box
compatibility, replacement preview/confirmation, undo restoring the rectangle,
manual-mask saving and unsaved-stroke detection blocking, Chinese/light and
English/dark presentation. In one browser replacement, 176,331 formerly ignored
pixels were restored to learning. Backend checks reject modified masks again at
apply time even if the earlier eligibility list is stale.

Full feature regression: `pytest` 3,707 passed / 4 skipped; `npm test` 685 passed;
`npm run build` passed (existing large-chunk advisory only). A subsequent focused
51-test run includes the additional snapshot path-escape regression. No loss
implementation or caption processing was changed. Automated tests cover fault
rollback, crash recovery, shared locking, bitmap integrity, ownership and missing
model/fallback behavior; visual review cannot replace those tests.

## Local startup

Use the clean `feature/face-contour-mask` worktree, not the original dirty checkout.
On the acceptance machine, ignored `tmp/start-face-contour.bat` reuses the original
Studio interpreter and the built frontend without changing its packages. The
worktree's ignored data-location pointer is restored to the original data after
copy acceptance. Open `/projects/2/v/2/preprocess?tool=inpaint`, select version
**v1** if the existing version selector remembers another version, then **Mask**.

Face spatial masking does not remove identity-bearing caption tags.
