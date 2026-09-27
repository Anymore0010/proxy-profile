# proxy-profile

自用的代理配置仓库：**以 Quantumult X 为主**，从 Loon 配置转换并融合现有 QX 配置而来。

生成的配置：**`QuantumultX/default.conf`**（唯一一份，所有资源指向本仓库快照）。

| 文件 | 作用 |
|---|---|
| `QuantumultX/default.conf` | **日常导入用的配置** |
| `QuantumultX/rules/` | 预转换的 QX 原生规则（不依赖运行时解析器） |
| `snapshot/` | 全部上游资源的冻结副本（配置里的每个 URL 都指向这里） |
| `legacy/loon/` | 原始 Loon 配置（转换来源，保留备查） |
| `legacy/quantumultx/` | 本机在用的 QX 配置（对比基准） |
| `MAPPING.md` | Loon 插件 → Quantumult X 资源逐条映射 |
| `DIFF.md` | **本配置 vs 你的 Loon vs 你的 QX** 逐段差异 |

> 起点是 Loon 转换，但本仓库的目标是**维护一套长期可用的自用 QX 配置**：
> 像 `fmz200/wool_scripts` 那样，把规则、重写、快照与生成脚本都放在版本控制下，
> 上游变化时靠每周任务自动跟进，而不是手工改配置。

## 为什么不是简单的格式翻译

Loon 和 Quantumult X 的差异不在语法，而在**功能承载方式**：

| 能力 | Loon | Quantumult X |
|---|---|---|
| 增强模块 | 插件 `.lpx`（自带 Rewrite / Script / MITM / 定时任务） | 没有插件系统，只有 `rewrite_remote` + `task_local` |
| 节点筛选 | `[Remote Filter]` 的 `NameRegex` | `[policy]` 里的 `server-tag-regex` |
| 分流规则 | `[Rule]` / `[Remote Rule]`（`.lsr`） | `[filter_local]` / `[filter_remote]` |
| 证书 | `[Mitm]` 内嵌 p12 | 必须在 App 内现场生成 |

原配置里有 **40 个 kelee.one 的 `.lpx` 插件**。这些插件是 Loon 专用的，无法在 Quantumult X 里直接运行，所以这部分**不是简单翻译，而是逐插件转换**：

- `vendor/loon-plugins/` 保存了这 40 个插件的**原样副本**（唯一事实来源）。
- `tools/convert-plugins.mjs` 把每个插件的 `[Rule]` / `[Rewrite]` / `[Script]` / `[MitM]` 转换成 Quantumult X 的 `[filter_remote]` / `[rewrite_remote]` 资源，产物按用途分目录：重写 `QuantumultX/rules/rewrite/kelee/*.snippet`、分流 `QuantumultX/rules/filter/kelee/*.list`。
- **脚本一律镜像进本仓库**（`snapshot/host/kelee.one/...`）。原因：kelee.one 只对 Loon 的 User-Agent 放行，Quantumult X 抓脚本时用的是它自己的 UA，会拿到 **403**，脚本静默不执行、功能表现为「没生效」——必须换成仓库内地址。

转换的实测结果（`QuantumultX/rules/rewrite/kelee/_conversion-report.json` 有逐条明细）：

| 项 | 数量 |
| --- | --- |
| 插件 | 40（38 启用 / 2 禁用，与源配置一致） |
| 转换出的分流规则 | 634 |
| 转换出的重写规则 | 368 |
| [mitm] 显式列出的主机名 | 1303 |
| 跨源去重跳过 | 72（与 fmz 聚合 / 自用增强命中同一响应体） |
| 无法转换、已逐条记账的 | 128 |
| 保真度提示（已转换但行为可能不同） | 24 |

比早期版本多恢复的映射（都是 QX 里**有**精确对应、此前被误判为"不支持"的）：

- `URL-REGEX` 分流 → 重写 `<re> url reject`（恢复 22 条 http:// 的 HTTPDNS 拦截）
- `USER-AGENT` 分流 → QX 的 `user-agent` 类型（恢复 4 条按 UA 拦 HTTPDNS）
- `AND((URL-REGEX), (USER-AGENT))` → `<re> \r\nUser-Agent: <ua> url-and-header reject`
  （官方 sample.conf 就是这个形状；恢复拼多多的 2 条直连 IP 广告拦截）
- `response-body-json-replace a v` → `jsonjq-response-body '.a = v'`
- `jq-path=` 外链 jq → 抓回并**折叠成单行**再内联（剥掉 `#` 注释，否则会把单行 rewrite 截断）

跳过的（转换器逐条记账，绝不静默丢弃）。⚠ 分清两类：

**A. QX 真的没有的语法**（无法实现）：

- `AND(... PROTOCOL QUIC)` —— QX 无 PROTOCOL 条件；已由 `[general]` 的 `udp_drop_list=443` 覆盖
- `DEST-PORT` 分流 —— QX 分流词表里没有
- `AND/OR/NOT` 里含 `OR`、或无重写等价物的组合
- `response-header-add` —— QX 无行内动作，需 `script-response-header` 小脚本

**B. QX 有等价物、之前只是转换器没实现**（已补齐）：

- `mock-response-body` → `echo-response`（含 base64 → `data:…;base64,`）
- `response-body-replace-regex` → `url response-body <re> response-body <repl>`
- ~~`header <url>`~~ —— 语义待核实（resource-parser 归为 302/307，Script-Hub 反而原样保留），未设备验证前**不猜迁移**
- `request/response if ${url} ~= /re/ then …` → 条件本身就是 URL 正则，直接当 pattern
- `response.json.jq` / `.json.delete` / `.json.jq_file` / `body.mock` / `reject_dict(200)` → `jsonjq-response-body` / `echo-response` / `reject-dict`
- 脚本镜像失败时**整条丢弃**（绝不回退成上游直链）：`CommonScript/replace-body.js` 已 404（1 条）

### kelee 插件是**权威上游**（其它重写资源只补空缺）

按用户要求「复刻插件效果」，优先级是：kelee 条目排在合并组的**第一个来源**，
其余上游（fmz 聚合、blackmatrix7 等）只补 kelee 没覆盖的部分。

**跨源去重由 `tools/vendor-rules.mjs` 的合并步骤负责**，在合并时按
`(正则, 动作)` 精确比对 + 语义判据（`tools/lib/rule-target.mjs` 的 `sameTarget`）
跳过重复 —— 因为 kelee 排第一，「先到者胜」就等于 kelee 胜出。
每个来源前都有**分块注释**标明出处与贡献条数，重复的在后面块里已被跳过。

只在**真有风险**时才会因去重丢掉规则：两边都改写响应体（`script-*` / `jsonjq-*`）
才会让同一个 body 被两套脚本处理；`reject` 族重复是幂等的，保留即可。

> 早期版本用过 `_exclusions.json` + 就地改写快照的方案，已移除：
> 合并后那些资源不再是 `rewrite_remote` 条目，清单永远落不了地，
> 且会因「读被改写的快照 -> 找不到重叠 -> 清单自我清空」而形成每周振荡。

### 保真度提示：这三类行为与源插件不同（已在 `_conversion-report.json` 的 `notes` 里逐条列出）

- **插件参数被丢弃**（11 条）：Loon 的 `argument=` / `[Argument]` 在 QX 没有等价物，脚本会走默认分支。
- **二进制体脚本（未设备验证）**（11 条）：`binary-body-mode` 的 protobuf 脚本，QX 侧能否正确解包未经实测。
- **条件启用无法表达**（2 条）：`enable={...}` 在 QX 只能无条件生效。

**关于抓取插件需要 Loon 的 User-Agent**：kelee.one 对 `curl` / 无头浏览器一律返回 Cloudflare 403，只有 `Loon/998 CFNetwork/...` 能过。`tools/fetch-plugins.mjs` 与 `tools/fetch-snapshot.mjs` 都已带上该 UA。

重新生成：

```bash
bun tools/fetch-plugins.mjs     # 抓/更新 40 个 .lpx 原样副本
bun tools/convert-plugins.mjs   # 转换为 QX 资源（含脚本镜像 + 跨源去重）
```

## 使用步骤

### 1. 导入配置

在 Quantumult X 中：

- **风车 → 配置文件 → 添加配置**，或直接打开链接导入：

  ```
  https://raw.githubusercontent.com/Anymore0010/proxy-profile/master/QuantumultX/default.conf
  ```

### 2. 添加订阅链接

订阅链接是个人敏感信息，**刻意没有写进仓库**。请自行添加：

- **风车 → 节点 → 添加订阅**，粘贴你的订阅链接；
- 或编辑配置文件里 `[server_remote]` 段（那里有一段注释示例）。
- 本配置已设置 `resource_parser_url`，会自动把 Clash / Surge / Loon 格式的订阅转成 Quantumult X 节点。

> 节点名必须含地区关键词（如 `香港`、`🇭🇰`、`HK`），策略组才能按正则筛选到。原 Loon 的正则已原样保留。

### 3. 生成并信任证书

**风车 → 设置 → MITM → 生成证书 → 安装描述文件**，然后到
**设置 → 通用 → 关于本机 → 证书信任设置** 里开启信任。

没有这一步，所有去广告重写都不会生效。

### 4. 选择策略组

导入后先把各地区的「手动策略」选好（香港 / 新国 / 日本 / 美国 / 全球），否则规则命中的策略组是空的。

### 自动刷新状态

**已启用**：`.github/workflows/snapshot.yml` 已在 master 上并被 GitHub 注册（state: active）。

- 每周一 **03:17 UTC** 自动刷新（重转规则 → 拉快照 → 校验 → 有变化才提交）；
- 也可在 **Actions → Snapshot → Run workflow** 手动触发；
- 任何上游失效都不会中断整批刷新：失败的资源记录在 `snapshot/index.json` 与
  `QuantumultX/rules/CONVERSION.md`，任务最后一步才会标红提醒。

本地手动刷新：

```bash
bun tools/vendor-rules.mjs     # 重转 Loon 规则为 QX 原生格式
bun tools/build.mjs            # 生成 QuantumultX/default.conf
bun tools/fetch-plugins.mjs    # 抓取 40 个 kelee 插件的原样副本
bun tools/convert-plugins.mjs  # 把插件转换成 QX 资源（含脚本镜像）
bun tools/fetch-snapshot.mjs   # 拉取/刷新快照（配置指向的就是它）
bun tools/validate.mjs         # 校验
```

## 目录结构

```
QuantumultX/default.conf          唯一配置（从 sources.json 生成，勿手改）
snapshot/index.json               快照清单：每个资源的来源、状态
tools/sources.json                唯一事实来源：所有外部资源与本地规则
tools/build.mjs                   生成 default.conf
tools/fetch-snapshot.mjs          拉取/刷新快照
tools/validate.mjs                校验生成的配置
tools/fetch-plugins.mjs           抓取 kelee 插件（需 Loon 的 User-Agent）
tools/convert-plugins.mjs         插件 -> QX 重写/分流资源 + 脚本镜像
vendor/loon-plugins/              40 个 .lpx 的原样副本 + index.json（sha256）
QuantumultX/rules/rewrite/**      重写资源（.snippet）
QuantumultX/rules/filter/**       分流资源（.list）
legacy/loon/                       原始 Loon 配置（转换来源）
legacy/quantumultx/                你本机在用的 QX 配置（对比基准）
MAPPING.md                        插件 → Quantumult X 资源逐条映射
```

改配置请改 `tools/sources.json`，然后：

```bash
bun tools/build.mjs          # 重新生成 QuantumultX/default.conf
bun tools/validate.mjs       # 校验
bun tools/fetch-snapshot.mjs # 刷新快照
```

## 快照机制

配置文件依赖 **176 个**第三方资源（含图标与脚本）。任何一个上游仓库被删或强推，配置就会**静默地少掉规则**。

因此 `snapshot/` 保存了一份冻结副本，配置里的所有资源都指向它：

- GitHub Actions **每周一 03:17 UTC 自动刷新**（已启用，实测可运行）；
- 上游挂掉时，配置里的资源仍指向快照副本，**照常工作**（这就是冻结副本的意义）；
- 手动刷新：`bun tools/fetch-snapshot.mjs`。

**只有一份配置**（`default.conf`），它指向的全部是本仓库快照 —— 上游失效不影响使用，代价是最长 7 天的更新延迟（每周任务刷新）。

## 规则已预转换为 Quantumult X 原生格式

原本有 3 份规则依赖 QX 的**运行时资源解析器**（`opt-parser=true`，即 Loon 格式文件在手机上现转）。
现已改为**在本仓库内预先转换**，存于 `QuantumultX/rules/`：

| 产物 | 位置 | 说明 |
|---|---|---|
| 单源 vendor | `rules/filter/*.list` | 一个上游一份（如 `AWAvenue.list`、`AppleIntelligence.list`） |
| 合并组 | `rules/filter/*.list` | 多个上游合成一份（AI / Meta / Google / GitHub / X / Telegram / Spotify / Netflix / Disney / ApplePush / Apple / AdsBlock） |
| kelee 插件转换 | `rules/filter/kelee/*.list`（分流）、`rules/rewrite/kelee/*.snippet`（重写） | 由 `tools/convert-plugins.mjs` 生成 |
| 重写合并组 | `rules/rewrite/AdsBlock.snippet`、`HTTPDNSBlock.snippet` | 见下方「合并组」 |

> **`blackmatrix7` 同目录下的 `.list` 与 `.conf` 是两种语法，不能混用**：
> `AdvertisingLite.conf`（1236 行 `^regex url reject-dict`）是 QX **重写**资源；
> `AdvertisingLite.list` 只有 `HOST/HOST-KEYWORD/IP-CIDR, x, AdvertisingLite`，
> 是 **Surge/Loon 格式的分流**列表。`.conf` 才是重写。

每个生成文件都有**分块注释**标明每个来源与贡献条数（重复的已在后面块里跳过）。

**为什么预转换，而不是让手机现转：**

1. QX 的远程资源**没有 fallback**——文件 404 或解析器脚本一改，规则就在设备上**静默消失**；
2. 运行时解析器转换不了的规则会被丢弃，而且**只在 iOS 上弹一条通知**，很容易漏掉。
   实测 fmz 的 `AI.list` 里有 2 条 `AND` 规则就是这样丢的；
3. 预转换的结果可以**在 git 里审查**，改动、丢弃都留痕。

丢弃的规则记录在 `QuantumultX/rules/CONVERSION.md`（QX 分流不支持 `AND`/`OR`/`NOT` 组合规则，
官方 sample.conf 中也不存在这些类型；拆开写会放宽匹配条件，故选择丢弃）。

重新生成：`bun tools/vendor-rules.mjs`（每周 workflow 也会跑）。

> 其余 `filter_remote` 条目用的是 blackmatrix7 / fmz200 的**原生 Quantumult X 规则库**，
> 本来就不需要解析器，保持上游链接以便自动更新。

## 融合了 fmz200 日常配置

本配置不止是 Loon 的单向转换，还融合了 [`fmz200/wool_scripts`](https://github.com/fmz200/wool_scripts)
的 Quantumult X 日常配置（`QuantumultX/config/QuanX.conf`），因为那套规则覆盖面更广：

| 来自 | 内容 |
|---|---|
| Loon 配置 | 本地分流规则、8 个地区策略组及其正则、DNS、远程分流的语义 |
| fmz200 | 广告拦截合集（重写 + 约 9700 条 reject 分流）、小程序清理、AI/抖音/小红书/快手/GeoIP_CN 分流、策略组、交互式任务 |

### 关于去重

两个层次，都在**生成期**完成，不依赖设备：

1. **合并组内部**（`tools/vendor-rules.mjs`）：按 `(类型, 值)`（分流）或
   `(URL正则, 动作)`（重写）去重；会改写响应体的动作再加一层**语义**判据
   （`sameTarget`），因为上游常把同一接口写成不同正则（`^https:\/\/x` vs `^https?:\/\/x`）。
   来源顺序即优先级，**kelee 排第一 = kelee 胜出**。
2. **与独立条目之间**：合并时会先收集所有非合并条目的语义签名（主要是逐个 App 的
   kelee 产物），重叠的让给独立条目（实测让给 50 条）。

`reject` 族重复是**幂等**的（同策略同结果），不视为问题；只有「两边都改写响应体」才会
让同一个 body 被两套脚本处理，属于必须消除的形态。

## 分流规则体积说明

`[filter_remote]` 里的广告拦截有**两个变体，只启用一个**：

| 变体 | 文件 | bm7 来源 | 条数 | 体积 | 默认 |
|---|---|---|---|---|---|
| **主版本** | `rules/filter/AdsBlock.list` | `AdvertisingLite.list` | 40 022 | 约 1.3 MB | ✅ 启用 |
| 全量 | `rules/filter/AdsBlockFull.list` | `Advertising.list` | 288 195 | 约 11.5 MB | ⛔ 关闭 |

两者来源相同，只差 bm7 那一份的完整度：

| 组成（主版本） | 条数 |
|---|---|
| kelee `BlockAdvertisers`（排第一，含 direct 白名单） | 325 |
| fmz200 `filter/filter.list` | 2 594 |
| **blackmatrix7 `AdvertisingLite.list`** | 36 302 |
| AWAvenue | 801 |
| **合计（已去重）** | **40 022** |

`AdvertisingLite` 是 bm7 的精简版（3.8 万条 vs 28.4 万条），QX 启动开销小得多。
需要更全覆盖就把主版本关掉、启用全量版。

> 重写侧（`rules/rewrite/AdsBlock.snippet`）同时含 `Advertising.conf` 与
> `AdvertisingLite.conf`：**重写侧「Lite」规则更多**（1236 vs 751 条），
> 两份内容互补，不是子集关系。

## 相对原配置的取舍

**保留**

- 全部本地分流规则（逐条转换，见 `[filter_local]`）
- 8 个地区策略组及其正则筛选
- DNS（DoH 二源：阿里 + 腾讯，加 `prefer-doh3`；Google 已按需移除）
- 远程分流规则的语义
- 去广告、脚本能力（改用 Quantumult X 原生资源）

**未迁移**

- **订阅链接与证书**：敏感信息，需手动添加（这也是仓库可以公开的原因）
- **用户主动去掉的插件**：LoonGallery（插件仓库）、QuickSearch（快捷搜索）；kelee 版 WeatherKit 也去掉了（保留社区版 `iRingo WeatherKit`）。转换器里有 `SKIP_PLUGINS` 跳过清单，避免它们被每轮重新生成。
- **`[Host]` 段**：原配置为空

**行为差异（需知悉）**

- Loon 用 `AND`/`OR` 逻辑组合的分流规则，Quantumult X 远程规则不支持等价写法，极少数依赖组合条件的分流会失效。
- 各家去广告库实现不同，效果不会与 Loon 逐 App 完全一致，建议按 App 实测。
- **只有一份配置**：`default.conf` 的全部资源都指向本仓库快照（`prefer_local=true`），没有第二份「离线配置」。上游失效不影响使用，代价是最长 7 天更新延迟。
- **插件参数未复刻**：Loon 的 `argument=` / `[Argument]` 在 QX 没有对应机制，脚本走自身默认分支（逐条记账在 `_conversion-report.json`）。

## 许可证

配置转换部分为个人使用。引用的第三方规则 / 脚本版权归各自作者所有，本仓库仅做引用与快照备份。
