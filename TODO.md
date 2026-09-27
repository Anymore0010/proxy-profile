# TODO

> 待办清单。完成后把条目挪到「已完成」并附提交号。

## 待办

### QX 脚本类功能调试（用户计划后续花时间处理）

v1.0.0 迁移时确认的硬缺口 —— **QX 无等价物**，不是遗漏。全部明细见
`QuantumultX/rules/rewrite/kelee/_conversion-report.json` 的 `skipped` 段（97 条逐行记录）。

- [ ] **B 站 stun/tracker 组合拦截**：`chat.bilibili.com + (stun|tracker|p2p)` 的 AND/OR
  组合 reject 在 Loon 插件里有（kokoryh bilibili.lpx + kelee Bilibili_remove_ads.lpx 各一份），
  QX 分流不支持逻辑组合、也没有重写等价物 —— 考虑在 `My.snippet` 用 URL 正则近似复刻。
- [ ] **`mock-response-body` 动作（7 条）**：QX 无此动作名，可评估改用
  `reject-dict` / `jsonjq-response-body` 是否等价（B 站 splash 等）。
- [ ] **`header` 动作（1 条，Spotify）** 与 **`response-body-replace-regex`（1 条，联通）**：
  QX 无对应动作，逐条评估替代写法或放弃。
- [ ] **`generic` 菜单脚本（Node_detection_tool 3 个）**：Loon 菜单触发脚本 QX 无挂载点；
  `[task_local]` 已有 6 个同类（NodeLinkCheck / traffic-check / server-info-plus…）覆盖大部分用途，
  缺的是「入口/落地检测 + 解锁检测」。注意：kelee 版依赖 Loon 的节点上下文（$environment.params），
  QX 下拿不到，迁移需找 QX 原生实现。
- [ ] **插件参数面板**：Loon `[Argument]` 的用户可调参数 QX 无机制，当前只有默认值内联
  （Sparkle B 站等带面板的插件只能用默认值）。

### 维护注意事项

- [ ] 修改 `rules/rewrite/kelee/*.snippet` / `rules/filter/kelee/*.list` **无效**：
  它们是 `tools/convert-plugins.mjs` 每周 CI 整份重写的生成物。要改行为请改
  `My.list` / `My.snippet`（个人覆盖，merges[0] 先到者胜）或改转换器源码。
- [ ] 广告拦截条目的**顺序**（AdsBlock 在 kelee 逐 App 条目之前）是用户指定，校验器不拦；
  `_filter_order_note` 已如实记录取舍（ad.12306.cn / cupid.iqiyi.com 的 kelee direct 被
  AdsBlock reject 覆盖 —— 用户抓包确认为期望行为），勿「修」回去。

## 已完成