---
date: 2026-10-15
tag: migration
title: Untagged images now take part in training
pin: true
version: "0.29.0"
---
Starting with v0.29.0, whether an image in the training set trains depends only on the scan range, not on whether it has a caption. Images with a missing or empty caption train with empty text.

**This applies automatically. If your training set holds untagged images you don't want to train on, you need to handle them yourself.**

- The same dataset may now produce more samples, different buckets, and a higher step estimate; check the estimate on the Train page before starting.
- Tagging and tag editing no longer require every image to be tagged before you can move on. Tag editing marks both missing and blank captions as “Untagged” so gaps are easy to spot.
- To keep images out of training, move them out of the training set. To train them with tags, run tagging with “existing” set to Skip to caption only the untagged images.

See the [caption format guide (Chinese)](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio/blob/master/docs/user-guide/caption-format.md) for the full rules.
