# 0023 — 将新驱动的 PyTorch 自动安装目标更新为 cu132

**状态**：Accepted
**日期**：2026-11-10
**决策者**：本地部署用户（明确要求保留 cu132 并更新自动安装）

## 背景

当前 RTX 5090 / 617.42 环境已验证 torch 2.15.0+cu132 与配套 FlashAttention，
但 Studio 自动重装和首次启动安装仍推荐 cu128。xformers 官方安装说明目前
只列 cu126/cu128/cu130，cu132 官方索引在当前 Windows/Python 环境下无匹配包。

## 决策

- Studio 和标准库 bootstrap helper 的自动推荐表同步新增 cu132。
- 自动推荐采用保守的驱动主版本 596 门槛，高于 CUDA 13.2 GA 对应的
  595.45.04；不把该应用策略称为 CUDA 的最低驱动要求。保留旧驱动原有选项。
- cu132 环境隐藏 xformers 安装 section 和训练 schema 的 xformers 选项，
  安装服务在调用 pip 前拒绝，auto attention 不选择 xformers。
- 保留持久化配置枚举、其他环境后端实现及旧配置的读取能力。
- 现有指定 Krea2 版本通过配置 API 改为 flash_attn；不启动新训练。

## 候选方案与理由

全部环境删除 xformers 会影响原有受支持环境；尝试社区 wheel 或源码编译
超出本次官方安装支持要求。当前策略只约束已核验的 cu132 缺包情形。
不在每次 schema/status 请求中联网；上游补齐官方包后需重新核验并更新策略。

## 后果

自动安装保持 CUDA 13.2；torch 与扩展仍需版本配套。没有官方预编译包不等于
源码绝对无法编译。旧 YAML 的 xformers 值仍可读取，不进行批量迁移。

## 参考

- https://github.com/facebookresearch/xformers#installing-xformers
- https://download.pytorch.org/whl/cu132/xformers/
- https://docs.nvidia.com/cuda/archive/13.2.0/cuda-toolkit-release-notes/index.html
