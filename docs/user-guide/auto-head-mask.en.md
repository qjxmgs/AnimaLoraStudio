# Automatic head masks

The local v0.27 distribution keeps two entry points. The header **Auto mask** is
the upstream quick rectangle workflow. The right-hand review panel in **Training
mask** mode retains precise contours, per-face confirmation, safe replacement and
protected Undo. The contour and legacy-proposal instructions below refer to that
review panel; the final section describes the independent upstream quick action.

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

## v0.27 upstream quick rectangle workflow

Automatic head masks are intended for clothing, pose, and style LoRAs where cartoon faces, hair, ears, and head accessories should not contribute to the loss. The feature adds unsaved `.mask` edits only; source images and captions are never modified.

## Set up recognition models

Open **Settings → Preprocess → Head detector**. Head detectors use the same model-source controls as upscalers:

- Choose HuggingFace or ModelScope as the download source.
- Select the globally preferred installed detector with its radio button.
- Use the pinned built-in detector, add a download by repository plus `.onnx` filename, or register an existing absolute `.onnx` file.
- Downloaded models are managed in the detector model directory. Registered local files stay in place and are never copied or deleted.
- Removing or deleting the selected custom detector falls back to the built-in detector.

The built-in weight is revision-, size-, and SHA-256-pinned. Custom detectors must implement the same YOLO ONNX input/output layout; incompatible or missing files fail safely without changing an image or mask.

## Workflow

1. Open **Preprocess → Retouch** for a project version. Choose **Auto mask** in the header, immediately before **Save all**.
2. Select an installed **Recognition model**, then choose **All images** or **Current image** and set confidence, padding, and feather. If no compatible model is installed, the modal directs you to Settings → Preprocess. Model download and file management are not embedded in this modal.
3. Choose **Start**. The established NMS IoU default of 0.7 is used internally. Successful enqueue closes the modal while the page owns the background job.
4. When detection finishes, every successful, non-stale region is added directly to the corresponding mask layer as an unsaved edit. The editor switches to **Training mask** and **Brush** so the result can be corrected immediately. Failed, skipped, stale, and successful no-head images remain clean.
5. Each affected image receives one grouped history operation, regardless of how many heads it contains. Ctrl+Z removes that image's whole automatic addition; redo restores it. Manual mask brush and eraser edits continue on the same history.
6. Use the existing **Save current** or **Save all** actions to persist the mask. Until then, Filmstrip dirty state includes the automatic edits. Unsaved edits block starting another Auto mask run.
7. On the Train page, enable masked loss when required. Leap and NaViT Packing remain incompatible with masked loss and must be disabled first.

There is no proposal review panel, selectable box overlay, Apply action, or separate automatic-mask undo action. Proposal data is only an internal transport from the completed job to the existing mask editor.

## Parameters

- **Confidence**: higher values reduce false positives but may miss small heads. Default: 0.413.
- **Padding**: expands each detected rectangle by a percentage of its width and height. Default: 0.10 (10%).
- **Feather**: adds the exact configured transition outside the expanded rectangle. Default: 0.03 (3%).

Allowed ranges are confidence 0.01–0.99, padding 0–1, and feather 0–0.5. Empty or out-of-range values show field-local errors. NMS IoU is fixed at the established 0.7 default and is not shown in the modal.

## Safety

- Detection and result retrieval do not persist image or mask files. Save current / Save all are the only persistence boundaries.
- The result endpoint checks the source image identity. Results marked stale because dimensions, file size, or modification time changed are not incorporated.
- Project, version, and job identity guard asynchronous responses, so a late response cannot modify another workspace.
- Legacy proposal/apply/undo endpoints remain compatible for older clients, but this UI does not call apply or undo.
- This feature does not edit captions. Character names, hair colors, eye descriptions, and other identity tags still condition training; remove them manually on the Tagging page when required.

The built-in detector comes from `deepghs/anime_head_detection`. See [ADR 0018](../adr/0018-proposal-based-auto-head-mask.md) for its pinned revision and integrity contract, and `THIRD_PARTY_NOTICES.md` for licensing notes.
