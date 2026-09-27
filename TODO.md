# TODO

> 待办清单。完成后把条目挪到「已完成」并附提交号。

## 待办

### QX 脚本类功能调试（用户计划后续花时间处理）

> **状态（本轮已修）**：原先记为「QX 无等价物」的多数动作，核对官方 `sample.conf`
> 后确认 QX 都有等价物，只是转换器没实现 —— 已补齐转换：
> `mock-response-body` → `echo-response`（含 base64）、
> `response-body-replace-regex` → `url response-body …`、
> `header <url>` → `url 302`、
> `response.json.jq`/`.json.delete`/`.json.jq_file`/`body.mock`/`reject_dict(200)` → `jsonjq-response-body`/`echo-response`/`reject-dict`、
> `if ${url} ~= /re/ then …` → 条件即 URL 正则。
> 重写规则 359 → 390 条，跳过 97 → 88 条。

剩**真正无 QX 等价物**的（详见 `_conversion-report.json` 的 `skipped`）：

- [ ] **`response-header-add`（1 条）**：QX 无行内改响应头动作，需写一个
  `script-response-header` 小脚本（B 站 gRPC 的 `grpc-status: 0`）。
- [ ] **`AND/OR/NOT` 逻辑组合分流（6 条）**：QX 分流不支持组合，也无重写等价物。
  影响最大的仍是 B 站 `chat.bilibili.com + (stun|tracker|p2p)` 组合 reject。
- [ ] **`DEST-PORT`（4 条）** / **`AND(...PROTOCOL QUIC)`（3 条）**：
  QUIC 已由 `udp_drop_list=443` 覆盖；DEST-PORT 无对应。
- [ ] **`generic` 菜单脚本（Node_detection_tool 3 个）**：QX **有**挂载点
  （`[task_local]` 的 `event-interaction`），但这些脚本依赖 Loon 的节点上下文
  （`$environment.params.node` / `nodeInfo`），QX 下拿不到 —— 迁过来只是个点了报错的入口。
  功能已由 `tasks` 的「节点详情查询」替代（`replaces` 字段）。
- [ ] **`binary-body-mode` 脚本（10 条）**：QX 侧能否解包 protobuf 未经设备验证。
- [ ] **插件参数面板（7 条）**：Loon `[Argument]` 的用户可调参数 QX 无机制，只有默认值内联。

### 维护注意事项

- [ ] 修改 `rules/rewrite/kelee/*.snippet` / `rules/filter/kelee/*.list` **无效**：
  它们是 `tools/convert-plugins.mjs` 每周 CI 整份重写的生成物。要改行为请改
  `My.list` / `My.snippet`（个人覆盖，merges[0] 先到者胜）或改转换器源码。
- [ ] 广告拦截条目的**顺序**（AdsBlock 在 kelee 逐 App 条目之前）是用户指定，校验器不拦；
  `_filter_order_note` 已如实记录取舍（ad.12306.cn / cupid.iqiyi.com 的 kelee direct 被
  AdsBlock reject 覆盖 —— 用户抓包确认为期望行为），勿「修」回去。

## 已完成