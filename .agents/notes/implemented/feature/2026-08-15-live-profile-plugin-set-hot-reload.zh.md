# Agent Note: Live profile plugin-set hot reload

Status: implemented

[English](2026-08-15-live-profile-plugin-set-hot-reload.md) | 中文

## 问题

`dsh plugin add/remove` 会在长期运行的 surface（`dsh web`、`dsh --profile headless`）运行期间改写 profile 的 `package.json`，但运行中的实例无法感知插件集合变更：组合包层在启动时被做成快照（`composeLive` 静态持有 `composed.bundlePatches`），而 client-modules 对「非客户端包」的判定永久缓存（"plugin-set changes take effect on restart"）。安装或卸载插件被迫整体重启——这正是 `cordis.patch.yml` 实时编辑已经为配置消除的摩擦。

## 决策

长期运行的 surface 监听 profile manifest。`watchProfileManifest`（app-boot）向现有 Cordis HMR 服务注册 profile 的 `package.json`；当某次写入改变了 `dsh.profile.bundles` 列表时，它通过 `resolveProfileLiveStack` 重新解析整条 patch 栈（组合包层从磁盘重读，随后是 profile patch 文件、home patch 文件与静态 overlays，每次调用全新克隆），并经与 patch 文件监听相同的根 Include 事务性重放路径（`reapplyRootInclude`）落地。已列出但 `node_modules` 尚未物化完成的组合包——pnpm 安装竞态——抛出 `BundlePendingError`；监听按有界退避重试（默认 250→5000 ms，12 次尝试），再经同一条 `hmr/config-update-failed` 通道报错。bundle 列表未变的写入（仅依赖变更或版本号调整）会被跳过。

浏览器侧把插件集合变更转化为一次整页刷新：hmr 的 node 半现在会广播每次图（graph）变更（此前只有连接时的快照），浏览器半把帧里的 `graph.rev` 与页面启动 manifest 的 rev 对比，不一致时执行一次 `location.reload()`。启动清单从未命名过的行无法热换，因此整页刷新正是预期粒度；新页面携带的 manifest 带有新 rev，重载不会循环。

## 触发面

新插件的主机命令在树重放后立即可用（fiber 挂载无需整页刷新）；客户端选择器或 UI 在浏览器刷新后出现。卸载是对称的：重组合后的栈不再插入该行，`root.update` dispose 该 fiber，client-modules 移除该行，图 rev 变化，浏览器刷新。已列入列表的组合包做版本更新（`dsh plugin update`）时，运行中的主机代码要等重启后才生效——web 组合中模块级重载仍处于禁用状态——而更新后的客户端 bundle 仍会经 stat 轮询热替换。

## 备选方案

- **CLI → 服务器 IPC**（`dsh plugin` 通知运行中的实例）。更显式，但要新增第二套 wire 协议和存活探测；manifest 文件本就是唯一写入口，且 config-HMR 模式已经证明文件监听触发足够。
- **Live-setGraph 客户端 API**（在模块系统内增量换行）。省掉整页刷新，但要中途重建浏览器 loader 树，且会引入串行化重载路径已为已知行解决的级联竞态；v1 不值得。
- **为主机代码重新启用模块级 `hmr` 行**。web 组合包是刻意禁用它（其重载生命周期未测试）；配置树重放路径是经过测试的机制，无需它即可覆盖插件集合场景。

## 后果

- **所得**：在运行中的 surface 上安装／卸载插件，主机代码即时生效，UI 在一次自动刷新后出现；CLI 无需改动（`dsh plugin` 仍是 pnpm 写方，运行中的 surface 只是 manifest 消费方）；失败收敛复用已验证的事务性树更新——坏组合包回滚，最后一个可用树保持活动。
- **代价**：对确切 manifest 文件的变更事件偶发丢失（原生 watch 丢弃事件）会把插件集合变更推迟到下一次事件或重启——`dsh plugin add/remove` 的写入事件间隔分明，因此该空窗在理论上才存在；图变更广播走 dev SSE 通道，是一条不进会话日志的新主机侧广播。
- **边界保留**：模块级主机重载保持禁用；`dsh plugin update` 的主机代码仍需重启生效；插件集合仍是用户发起的文件写入，本改动没有引入超出用户本就会编辑的文件的信任面。
