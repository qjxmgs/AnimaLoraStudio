# 0018 — Use instance segmentation for face-only loss masks

**Status**: Accepted
**Date**: 2026-09-07

## Context

ADR 0017's expanded head rectangles suppress shoulders and hair. A smaller box,
ellipse or convex hull cannot represent visible face boundaries and occluders.
Pixelwise-min application cannot shrink old rectangles without provenance.

## Decision

Keep `head_box` as the omitted API mode; the new UI explicitly selects
`face_contour`. Head boxes supply 10%-padded input crops only. Decode face instance
coefficients/prototypes, undo letterbox in floating point, then threshold at source
resolution. Preserve holes/disconnected pieces; no geometric fallback. Default
face confidence is 0.25, NMS IoU 0.7, mask threshold 0.5, outward padding 0 and
feather 0. Optional 1–3 pixel feather is inward only.

Use Anzhc/Anzhcs_YOLOs, `Anzhc Face seg 640 v4 y11n.pt`, revision
`f5a2306d7fed4f3cfc26c25ff1ab2e3f3cfce855`, 6,020,644 bytes, SHA-256
`1e77ad7bd349babd8a4a90478bfc965348642b63a8d95d3b43ee13db42fd0a64`.
Prepare in an independent venv: CPU torch 2.5.1, torchvision 0.20.1, ultralytics
8.3.216, onnx 1.19.0, onnxruntime 1.22.1, numpy 2.2.6, Pillow 11.3.0. Export static
FP32, 1×3×640×640, opset 17, no embedded NMS/simplifier. Three seeded inputs must
pass raw PyTorch/ONNX parity before one atomic ready pointer publishes an immutable
artifact. Record versions, settings, hashes and parity errors. Studio never imports
Ultralytics/OpenCV and reuses existing ONNX session fallback. Initial preparation
can download hundreds of MB; model weights and converters remain local/ignored.

Schema v2 proposals contain checksummed cropped loss-weight PNGs and source pixel
origins. UI preview and application use the same bitmaps. Scoped bitmap routes
validate task ownership, never accept filesystem paths, and retain v1 readability.

Normal application is `min(current, proposal)`. Explicit replacement binds job AND
apply identity, checks source snapshots/current masks/backups, and rebuilds from
the prior merge baseline. Replay legacy snapshots without hashes against recorded
applications. New records save separate checksummed undo and merge baselines.
Replacing marks prior records; guarded undo validates and restores the chain.
Unselected/no-face images remain unchanged; no-op applications preserve undo.

Manual writes/deletes/transformations and automatic applications share a
cross-process train-directory lock. Stage output and application metadata together
with a durable journal. Roll back failures and recover interrupted batches before
starting the supervisor. External changes that make recovery ambiguous block it.

## Consequences

Captions, source images, DB schema and loss semantics remain unchanged. Stylized,
small, profile and occluded faces require human review. The model card marks
AGPL-3.0; downloading/converting on demand is not a license exemption. Delivery is
local-only: no push, PR or release.

## References

- [Model author](https://huggingface.co/Anzhc/Anzhcs_YOLOs#face-segmentation)
- [Official export](https://docs.ultralytics.com/modes/export/)
- [ADR 0017](0017-proposal-based-auto-head-mask.md)
