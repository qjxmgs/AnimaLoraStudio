# qjxmgs Fork 上游同步手册

本发行版不自动合并官方仓库。线上更新只读取 `qjxmgs/AnimaLoraStudio`，且
`.anima-distribution.json`、自动头部遮罩实现标记、更新保护三者缺一时，更新
预检、更新 API 和启动期应用都会拒绝目标提交。`force=true` 只用于覆盖本地脏
工作树，不能绕过功能保护。

## 远端与分支

- `origin`: `https://github.com/qjxmgs/AnimaLoraStudio.git`
- `upstream`: `https://github.com/WalkingMeatAxolotl/AnimaLoraStudio.git`
- `origin/master` 和 `origin/dev` 都必须通过 Distribution Guard，并包含
  当前本地轮廓版要求 `required_features.auto_head_mask >= 2`；只有未来发布
  包含等级 2 的 Fork 分支，才可作为本地轮廓版的更新目标。

## 本地轮廓版（尚未发布）

`feature/face-contour-mask` 的功能标记与清单均升级为等级 2。等级 1 只有旧
矩形功能，不能覆盖轮廓版。预检、更新请求和启动期应用均检查等级，包含
`force=true`；回滚同样不能降回等级 1。未来先在本地合并官方更新、解决冲突、
运行完整测试并保留等级 2，再决定是否发布。等级数字不是发布授权。

本次交付仅有两个本地提交：功能及测试文档、Fork 更新保护升级。不执行下方
手册中的 push / PR / release 步骤，也不调整远端分支保护。

## 同步正式版

1. 确认 Fork `master` 和工作树干净，获取 `upstream/master` 与官方 tags。
2. 从 Fork `master` 创建 `sync/upstream-vX.Y.Z`。
3. 执行非快进合并：`git merge --no-ff upstream/master`。
4. 人工解决冲突。更新器、预处理路由、模型下载中心和训练配置冲突需要逐项复核，
   不允许用整文件覆盖的方式直接采用上游版本。
5. 运行：

   ```powershell
   python tools/check_distribution_features.py
   python -m pytest
   Set-Location studio/web
   npm test
   npm run build
   ```

6. 在真实服务中重新检查自动检测、选择、应用、撤销，以及训练页
   `masked_loss` 警告。测试或标记检查失败时停止，不推送目标分支。
7. 将 `sync/upstream-vX.Y.Z` 推到 Fork，向 `origin/master` 创建 PR。等待现有
   Tests CI（其 backend job 包含分发标记检查）成功并人工确认后再合并。

合并前线上用户看不到同步分支，因此冲突或失败不会影响当前可用版本。禁止直接
push、force-push 或删除 `master`。

## 主动退出定制发行版

只有维护者明确决定放弃 qjxmgs 定制功能时，才可在启动环境设置
`ANIMA_STUDIO_ALLOW_INCOMPATIBLE_UPDATE=1`。普通 UI 不提供该开关；启用后预检
会留下警告，启动日志也会记录绕过原因。完成迁移后应立即移除环境变量。
