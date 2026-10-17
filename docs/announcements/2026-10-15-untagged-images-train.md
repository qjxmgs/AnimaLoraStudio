---
date: 2026-10-15
tag: migration
title: 未打标的图片现在也会参与训练
pin: true
version: "0.29.0"
---
从 v0.29.0 起，训练集里的图片是否参与训练只看扫描范围，不再看有没有 Caption。没有 Caption 文件或 Caption 为空的图片会以空文本参与训练。

**自动生效；如果你的训练集里放了不想训练的未打标图片，需要手动处理。**

- 同一数据集的样本数、桶分布和预计步数可能比以前多；开训前可在训练页的预估里确认。
- 打标和标签编辑阶段不再要求所有图片都打完标签才能推进；标签编辑会把缺失和空白 Caption 统一标为「未打标」，方便查漏。
- 不想让某些图片参与训练时，请把它们移出训练集；想让它们带标签训练时，打标时「已有 caption」选「跳过」即可只给未打标的图片补标签。

详细规则见 [Caption 格式说明](https://github.com/WalkingMeatAxolotl/AnimaLoraStudio/blob/master/docs/user-guide/caption-format.md)。
