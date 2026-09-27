#!/usr/bin/env bun
/**
 * Generates QuantumultX/default.conf from tools/sources.json.
 *
 * The profile is generated, never hand-edited: sources.json is the single
 * source of truth so the profile and the snapshot it points at cannot drift.
 *
 *   bun tools/build.mjs           # write QuantumultX/default.conf
 *   bun tools/build.mjs --check   # fail if the committed file is stale
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "QuantumultX", "default.conf");

const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));

// Vendored filters live in this repo, not upstream. They are referenced by an
// absolute URL so Quantumult X can fetch them; the base is resolved from CI env
// vars or the git remote (never hard-coded).
const { resolveRepoBase } = await import("./repo-url.mjs");
const repoBase = resolveRepoBase(ROOT).rawBase;

/**
 * prefer_local=true 时，所有资源都指向本仓库快照：
 * 上游失效不影响使用（代价是最长 7 天的更新延迟）。
 */
const PREFER_LOCAL = src.output?.prefer_local === true;
/** 上游 URL -> 仓库内快照路径（构建时静态推导，避免依赖抓取结果）。 */
function snapshotLocalFor(url) {
  const m = (url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const m2 = (url ?? "").match(/^https:\/\/([^/]+)\/(.+)$/);
  return m2 ? `snapshot/host/${m2[1]}/${m2[2]}` : null;
}
/** 图标同样指向仓库内镜像（prefer_local 时）。 */
function iconUrl(u) {
  if (!PREFER_LOCAL || !u) return u;
  const p = snapshotLocalFor(u);
  if (!p) return u;
  // 只有快照里确实存在该图标时才指向本仓库；否则会变成 404 死链
  // （图标是装饰性的，指向上游反而更可靠）。
  try {
    if (!existsSync(join(ROOT, p))) return u;
  } catch { return u; }
  return `${repoBase}/${p}`;
}

/** Absolute URL for a filter entry (repo-local, vendored, or upstream). */
function filterUrl(f) {
  if (f.local_file) return `${repoBase}/${f.local_file}`;
  if (PREFER_LOCAL) {
    const p = snapshotLocalFor(f.url);
    if (p) return `${repoBase}/${p}`;
  }
  return f.url;
}

/**
 * Quantumult X comment marker. `#` is only valid as the first character.
 *
 * 必须逐行加前缀：note 里出现 `\n` 时，只给首行加 `#` 会留下裸行 ——
 * 落在 [filter_remote]/[rewrite_remote] 里会被 QX 当成一条规则解析
 * （既非注释也非合法规则，静默异常）。实测踩过：一条多行 note 的第三行
 * 直接写在 default.conf 里成了裸文本。
 */
const comment = (text) => String(text).split("\n").map((l) => `# ${l}`.trimEnd()).join("\n");

/**
 * Quantumult X requires literal `[section]` headers; a comment banner alone is
 * not a section. Emits the banner, the human-readable title, then the header.
 */
function section(key, title) {
  const bar = "#".repeat(72);
  return [bar, `# ${title}`, bar, `[${key}]`].join("\n");
}

function buildGeneral(g) {
  const lines = [section("general", "常规设置"), ""];
  lines.push(`resource_parser_url=${PREFER_LOCAL ? `${repoBase}/${snapshotLocalFor(g.resource_parser_url)}` : g.resource_parser_url}`);
  lines.push(`profile_img_url=${iconUrl(g.profile_img_url)}`);
  lines.push(comment(`节点测速 URL，超时 ${g.server_check_timeout}ms`));
  lines.push(`server_check_url=${g.server_check_url}`);
  lines.push(`server_check_timeout=${g.server_check_timeout}`);
  lines.push(comment("网络连通性检测 URL"));
  lines.push(`network_check_url=${g.network_check_url}`);
  lines.push(comment("节点页顶部的地理位置信息展示"));
  {
    const [, gurl] = g.geo_location_checker.split(",").map((x) => x.trim());
    const gu = PREFER_LOCAL && gurl && /^https?:/.test(gurl) ? `${repoBase}/${snapshotLocalFor(gurl)}` : gurl;
    lines.push(`geo_location_checker=${g.geo_location_checker.split(",")[0].trim()}, ${gu}`);
  }
  lines.push(comment("这些域名不使用 fake-ip，避免本地/内网域名被劫持"));
  lines.push(`dns_exclusion_list=${g.dns_exclusion_list}`);
  lines.push(comment("这些流量不交给 Quantumult X 处理"));
  lines.push(`excluded_routes=${g.excluded_routes}`);
  lines.push(comment("UDP 兜底：节点不支持 UDP 中转时使用。"));
  lines.push(`fallback_udp_policy=${g.fallback_udp_policy}`);
  if (g.udp_drop_list) {
    lines.push(comment("丢弃这些 UDP 端口（QUIC 等），避免与 TCP 分流策略不一致"));
    lines.push(`udp_drop_list=${g.udp_drop_list}`);
  }
  return lines.join("\n");
}

function buildDns(d) {
  const lines = [section("dns", "DNS"), ""];
  lines.push(comment("加密 DNS（DoH）。注意：设置后将忽略未绑定域名的明文 server；兜底走系统 DNS。"));
  if (d.no_ipv6) {
    lines.push(comment("禁用 IPv6（只走 A 记录）。对应你原 QX 配置的 no-ipv6。"));
    lines.push("no-ipv6");
  } else {
    lines.push(comment("保留 IPv6（不写 no-ipv6）。"));
  }
  if (d.prefer_doh3) {
    lines.push(comment("优先使用 DNS over HTTP/3；失败时自动回落 HTTP/2（QX 内置回落）。"));
    lines.push("prefer-doh3");
  }
  lines.push(comment("多个 doh-server 写在同一行、逗号分隔（并发查询，多路提高可用性）。"));
  lines.push(`doh-server=${d.doh_server.join(", ")}`);
  // 明文 UDP DNS 兜底（用户要求保留）。按官方文档，设了 doh-server 后未绑定域名的明文
  // server 会被忽略；但它们代价为零，且部分版本/场景下会回落到明文 server，故留作安全网。
  if (d.udp_dns_servers?.length) {
    lines.push("");
    lines.push(comment("明文 UDP DNS 兜底安全网（保留，勿删）："));
    lines.push(comment("官方文档称设了 doh-server 后未绑定域名的明文 server 会被忽略；"));
    lines.push(comment("保留是因为代价为零，且 DoH 异常时可回落。"));
    for (const s of d.udp_dns_servers) lines.push(`server = ${s}`);
  }
  if (d.domain_servers?.length) {
    lines.push("");
    lines.push(comment("按域名指定 DNS。官方文档：doh-server 只忽略「未绑定域名」的普通 server，"));
    lines.push(comment("这些绑定了域名的规则仍然生效。路由管理页用 system，避免在外网 DNS 下打不开后台。"));
    for (const s of d.domain_servers) lines.push(s);
  }
  return lines.join("\n");
}

function buildPolicy(p) {
  const lines = [section("policy", "策略组"), ""];
  lines.push(comment("按节点名正则筛选出的可选节点集合。"));
  lines.push(comment("resource-tag-regex=. 表示匹配全部节点订阅，与 server-tag-regex 一起决定候选节点。"));
  for (const r of p.regions) {
    lines.push(
      `static=${r.name}, resource-tag-regex=., server-tag-regex=${r.regex}, img-url=${iconUrl(r.icon)}`
    );
  }
  lines.push("");
  lines.push(comment("手动策略组：指定走哪个区域集合。"));
  const regionByName = new Map(p.regions.map((r) => [r.name, r]));
  for (const s of p.selects) {
    const region = regionByName.get(s.region);
    if (!region) throw new Error(`policy "${s.name}" references unknown region "${s.region}"`);
    lines.push(`static=${s.name}, ${s.region}, img-url=${iconUrl(region.icon)}`);
  }
  // 每个服务一条独立的 select 组：这样每条分流都能**单独**换节点，
  // 而不是被 force-policy 锁死到某个区域组。参考原 QX 配置的写法
  // （static=谷歌服务, proxy, 香港节点… 用户在组里自选）。
  if (p.services?.length) {
    lines.push("");
    lines.push(comment("以下为「每服务一条」的可选策略组：分流条目指向这些组，"));
    lines.push(comment("你可以在 QX 界面里逐条选择走哪个节点/区域，互不影响。"));
    for (const g of p.services) {
      const members = g.members.filter((m) => m === "direct" || m === "proxy" || regionByName.has(m));
      lines.push(`static=${g.name}, ${members.join(", ")}, img-url=${iconUrl(g.icon)}`);
    }
  }
  // 融合自 fmz200/wool_scripts 配置的策略组，供其分流规则使用。
  if (p.groups?.length) {
    lines.push("");
    lines.push(comment("以下策略组融合自 fmz200/wool_scripts 的日常配置，供对应分流规则使用。"));
    for (const g of p.groups) {
      const target = regionByName.get(g.region) ?? null;
      if (!target && g.region !== "direct") {
        throw new Error(`policy group "${g.name}" references unknown region "${g.region}"`);
      }
      lines.push(`static=${g.name}, ${g.region}, img-url=${iconUrl(g.icon)}`);
    }
  }
  return lines.join("\n");
}

function buildServerRemote() {
  const lines = [section("server_remote", "节点订阅"), ""];
  lines.push(comment("订阅链接属于个人敏感信息，刻意不写入本仓库。"));
  lines.push(comment("在 Quantumult X 里手动添加：风车 → 节点 → 添加订阅；或在本段末尾新起一行粘贴（不要以 # 开头）。"));
  lines.push(comment("解析器会自动把 Clash / Surge 等格式的订阅转成 Quantumult X 节点。"));
  lines.push("");
  lines.push(comment("示例（照抄一行并把链接换成你自己的，不需要「取消注释」）："));
  lines.push(comment("    <你的订阅链接>, tag=MyNodes, opt-parser=true, update-interval=86400, enabled=true"));
  lines.push(comment("上面这行必须以「链接」开头；若行首带 # 就会被 QX 当成注释而静默忽略。"));
  return lines.join("\n");
}

/**
 * [server_local] —— 本地节点。
 *
 * Quantumult X 要求这个段存在：缺失时导入会报「缺少模块 server_local」。
 * 原 Loon 配置的 [Proxy] 段是空的（节点全部来自订阅），所以这里也是空段，
 * 但必须显式输出段头。官方 sample.conf 的位置在 [server_remote] 之前。
 */
function buildServerLocal() {
  const lines = [section("server_local", "本地节点")];
  lines.push("");
  lines.push(comment("本配置无本地节点（节点全部来自订阅）。"));
  lines.push(comment("本段必须保留：Quantumult X 缺少 [server_local] 会报「缺少模块 server_local」而无法导入。"));
  lines.push(comment("如需添加本地节点，按下面的写法（去掉注释符）："));
  lines.push(comment("    shadowsocks=example.com:443, method=chacha20-ietf-poly1305, password=PWD, udp-relay=true, tag=Local-01"));
  return lines.join("\n");
}

function buildFilterLocal(l) {
  const lines = [section("filter_local", "本地分流"), ""];
  lines.push(comment("本地规则优先于同名远程规则。"));
  lines.push("");
  for (const rule of l.rules) lines.push(rule);
  lines.push("");
  lines.push(comment("如需屏蔽内网段，可加 ip-cidr, 10.0.0.0/8, direct 之类。"));
  lines.push(comment("未被任何规则命中的流量。"));
  lines.push(`final, ${l.final}`);
  return lines.join("\n");
}

function buildFilterRemote(filters) {
  // parser 必须是布尔：缺失时曾生成 "opt-parser=undefined"，QX 会解析失败。
  for (const f of filters) {
    if (f.parser !== true && f.parser !== false) f.parser = false;
  }
  const lines = [section("filter_remote", "远程分流"), ""];
  lines.push(comment("opt-parser=true 表示交给 resource_parser_url 转换（Surge/Clash 等格式的规则文件）。"));
  lines.push(comment("FILTER_REGION / FILTER_LAN 是 Quantumult X 内置资源。"));
  lines.push(comment("顺序即优先级：CN REGION 必须保持在最后。"));
  lines.push("");
  // `merge_source_only: true` 的条目**只作为合并源**参与 vendor-rules 的合并，
  // 不输出成 [filter_remote] 条目 —— 它的规则已经在合并产物里了，
  // 再列一条会让同一批规则在两个来源重复匹配。
  // 与 `enabled: false` 的区别：那个仍会输出条目（界面里能看到、可手动打开），
  // 这个则完全不出现。刷新照样由 `vendor: true` 驱动，不受影响。
  for (const f of filters) {
    if (f.merge_source_only) continue;
    const parts = [filterUrl(f), `tag=${f.tag}`];
    // 规则自带策略的资源（如各 bm7 原生列表）不设 force-policy，否则会覆盖其原有策略。
    if (f.policy) parts.push(`force-policy=${f.policy}`);
    if (f.icon) parts.push(`img-url=${iconUrl(f.icon)}`);
    parts.push("update-interval=86400", `opt-parser=${f.parser}`, `enabled=${f.enabled}`);
    if (f.note) lines.push(comment(f.note));
    lines.push(parts.join(", "));
  }
  return lines.join("\n");
}

function buildRewriteLocal() {
  const lines = [section("rewrite_local", "本地重写"), ""];
  lines.push(comment("本段留空：所有重写都在下面的 [rewrite_remote] 中以远程资源提供。"));
  return lines.join("\n");
}

function buildRewriteRemote(rewrites) {
  const lines = [section("rewrite_remote", "远程重写"), ""];
  lines.push(comment("每个条目对应一类 App/服务。"));
  lines.push(comment("hostname 由这些资源自带，Quantumult X 会自动合并进 MITM 主机名列表。"));
  lines.push("");
  for (const r of rewrites) {
    let u = r.local_file ? `${repoBase}/${r.local_file}` : r.url;
    if (!r.local_file && PREFER_LOCAL) {
      const p = snapshotLocalFor(r.url);
      if (p) u = `${repoBase}/${p}`;
    }
    const parts = [
      u,
      `tag=${r.tag}`,
      ...(r.icon ? [`img-url=${iconUrl(r.icon)}`] : []),
      "update-interval=86400",
      `opt-parser=${r.parser}`,
      `enabled=${r.enabled}`,
    ];
    lines.push(parts.join(", "));
  }
  return lines.join("\n");
}

function buildTasks(tasks) {
  const lines = [section("task_local", "任务"), ""];
  lines.push(comment("event-interaction 表示在 Quantumult X 中手动点击触发。"));
  lines.push("");
  for (const t of tasks) {
    let tu = t.url;
    if (PREFER_LOCAL) {
      const p = snapshotLocalFor(t.url);
      if (p) tu = `${repoBase}/${p}`;
    }
    lines.push(
      [
        `${t.schedule} ${tu}`,
        `tag=${t.tag}`,
        `img-url=${iconUrl(t.icon)}`,
        `enabled=${t.enabled}`,
      ].join(", ")
    );
  }
  return lines.join("\n");
}

function buildHttpBackend() {
  return [section("http_backend", "HTTP 后端"), "", comment("本配置未使用本地 HTTP 后端。")].join("\n");
}

function buildMitm() {
  const lines = [section("mitm", "MITM"), ""];
  lines.push(comment("证书必须在本机生成，任何证书私钥都不应提交到仓库。"));
  lines.push(comment("Quantumult X：风车 → 设置 → MITM → 生成证书 → 安装描述文件 → 到「设置-通用-关于本机-证书信任设置」开启信任。"));
  lines.push(comment("重导配置**不会**清除已生成的证书；若每次都要重新生成，那是证书本身没被信任。"));
  lines.push("");
  // 这里**刻意不写 hostname**：QX 会把 [rewrite_remote] 各资源自带的 hostname 行
  // 自动并入 MITM（用户在 QX 的 MITM 页面上直接看到过这些主机名），
  // 且用户原配置的 [mitm] 也只有 `hostname = -www.google.com` 一行，重写照常生效。
  // 再写一份 1300+ 主机名的清单纯属冗余：只会把配置撑大、把 MITM 页面塞满。
  // 每个重写资源自带 hostname 这一点由 validate 的 checkRewriteHostnames 强制保证：
  // 它递归覆盖 QuantumultX/rules/**（含 kelee/*.conf），**并且**覆盖 snapshot 里
  // 那些直链型重写资源（bm7 BlockHTTPDNS/Advertising、fmz rewrite.snippet、
  // chavyleung boxjs、NSRingo WeatherKit）—— 实测 31 个文件。
  lines.push(comment("本段不写 hostname：各 rewrite_remote 资源自带 hostname，QX 会自动并入 MITM。"));
  lines.push(comment("若确需额外主机名（资源没声明的），请在 QX 界面的 MITM 页面添加，或在此写 hostname = a.com, *.b.com。"));
  lines.push("");
  lines.push(comment("与 fmz 的 QuanX.conf、用户原 QX 配置保持一致（两边都显式设了 true）。"));
  lines.push("skip_validating_cert = true");
  // ⚠ 不写 `passphrase = ` / `p12 = ` 这两个**空值行**：
  // 官方 sample.conf 里它们是**注释掉**的（`;passphrase =`）；写成不带注释的空值行，
  // 等于显式声明「证书口令为空 / p12 为空」—— 可能覆盖本机在 QX 里生成的证书，
  // 导致 **MITM 全部失效**（所有 ^https:// 重写静默不生效）。
  // 这正是「同 URL 多条规则」「jsonjq 表达式」之外的另一条静默失效路径：
  // 规则内容全都对，但 QX 根本没能解密流量。
  lines.push(comment("不写 passphrase/p12 空值行：那会覆盖本机生成的证书（官方 sample.conf 是注释掉的）。"));
  lines.push(comment("证书请在 QX 里生成并到「设置-通用-关于本机-证书信任设置」开启信任。"));
  return lines.join("\n");
}


const profile = [
  comment("Quantumult X 配置 —— 自动生成，请勿手工编辑"),
  comment("改 tools/sources.json 后运行 `bun tools/build.mjs` 重新生成。"),
  "",
  buildGeneral(src.general),
  "",
  buildDns(src.dns),
  "",
  buildPolicy(src.policies),
  "",
  buildServerLocal(),
  "",
  buildServerRemote(),
  "",
  buildFilterLocal(src.local_rules),
  "",
  buildFilterRemote(src.filters),
  "",
  buildRewriteLocal(),
  "",
  buildRewriteRemote(src.rewrites),
  "",
  buildTasks(src.tasks),
  "",
  buildHttpBackend(),
  "",
  buildMitm(),
  "",
].join("\n");

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    /* missing file is a stale state */
  }
  if (current !== profile) {
    console.error(`${relative(ROOT, OUT)} is stale. Run: bun tools/build.mjs`);
    process.exit(1);
  }
  console.log(`${relative(ROOT, OUT)} is up to date.`);
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, profile);
  const counts = {
    filters: src.filters.length,
    rewrites: src.rewrites.length,
    tasks: src.tasks.length,
    policies: src.policies.regions.length + src.policies.selects.length,
    localRules: src.local_rules.rules.length,
  };
  console.log(`Wrote ${relative(ROOT, OUT)} (${profile.split("\n").length} lines)`);
  console.log(counts);
}
