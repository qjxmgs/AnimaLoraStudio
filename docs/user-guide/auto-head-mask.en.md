# Automatic head masks

## Face only · precise contour

The new UI defaults to contours; legacy rectangles remain selectable. Head boxes
are input crops only. Orange overlays show actual visible-face pixel masks,
aiming to retain hair, neck, shoulders and occluders. Review unusual styles, small
or profile faces manually. Missing/failed segments never fall back to a box or
ellipse. Use the undetected filter and normal brushes for corrections.

Choose **Download and prepare face segmenter** in preprocessing or Settings. The
checkpoint is about 5.74 MiB, but its independent conversion environment requires
hundreds of MB of CPU dependencies initially. Logs show progress/failures; retry
after fixing the cause. Studio's environment does not install Ultralytics/OpenCV.
All weights and converted artifacts stay local and are excluded from Git. The
model is marked AGPL-3.0; see third-party notices.

Defaults: face confidence 0.25, NMS IoU 0.7, mask threshold 0.5, no outward padding
and no feather. Optional 1–3 pixel inward feather does not expand the mask.
Review/select faces before applying, then use normal mask brushes if needed.

### Safely narrowing existing rectangles

Normal application unions masks and cannot restore shoulders inside a rectangle.
Use **Replace previous automatic masks**: choose an earlier application, select
new faces, preview differences, then confirm. Black means ignored; white means
learned. Counts show restored-learning/newly ignored pixels. Unselected images or
images without a selected face are unchanged.

Replacement verifies source snapshots, current mask hashes and backups. Later
manual edits, damaged backups or unknown provenance block it. Do not delete all
masks to bypass this guard. Earlier manual content survives. Undo returns to the
pre-replacement masks, including rectangles; later manual edits block automatic
undo. Save strokes before every automatic operation. Enable masked loss for
training; Leap/NaViT restrictions remain. Captions/identity tags are not removed.

## Legacy head rectangle

Automatic head masks are intended for clothing, pose, and style LoRAs where cartoon faces, hair, ears, and head accessories should not contribute to the loss. The feature writes `.mask` sidecars only; source images are never modified.

## Workflow

1. Open **Preprocess → Retouch → Mask** for a project version. On first use, choose **Download head detector**. The roughly 42.5 MiB weight is integrity-checked after download.
2. Save all manual strokes. Batch detection is disabled while any unsaved strokes exist.
3. Choose **Detect all** or **Detect current**. The defaults are confidence 0.413, NMS IoU 0.7, 10% padding, and 3% feathering.
4. Review the proposal overlays. Every region starts selected; clear individual regions or select/clear all regions on the current image. Use the **No head detected** filter to inspect likely misses.
5. Choose **Apply selected**. The automatic mask is merged with the existing manual mask using a pixelwise minimum, so it can never restore a manually ignored pixel.
6. On the Train page, use **Enable masked loss** when the warning appears. Leap and NaViT Packing remain incompatible with masked loss and must be disabled first.

## Parameters

- **Confidence**: higher values reduce false positives but may miss small heads. Start at 0.413; try 0.5–0.6 if false positives dominate.
- **NMS IoU**: controls removal of overlapping detections. The 0.7 default helps preserve people standing close together.
- **Padding**: expands each box by a percentage of its width and height. Ten percent usually covers hair tips, animal ears, and accessories.
- **Feather**: adds a 0-to-255 transition outside the expanded region. Three percent avoids an unnecessarily hard loss boundary.

## Safety and undo

- Detection writes a proposal only. Application validates the entire batch and prepares all temporary files before atomic replacement; a preparation failure leaves all masks unchanged.
- A proposal is stale and cannot be applied if the source image's dimensions, file size, or modification time changed after detection.
- **Undo this automatic mask** restores the pre-application snapshot. Undo is refused if a related `.mask` was manually changed afterward, protecting the newer edit.
- v1 does not edit captions. Character names, hair colors, eye descriptions, and other identity tags still condition training; remove them manually on the Tagging page when required.

The detector is downloaded on demand from `deepghs/anime_head_detection`. See [ADR 0017](../adr/0017-proposal-based-auto-head-mask.md) for the pinned revision and integrity contract, and `THIRD_PARTY_NOTICES.md` for licensing notes.
