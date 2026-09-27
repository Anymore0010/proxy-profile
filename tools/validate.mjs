#!/usr/bin/env bun
/**
 * Validates the generated Quantumult X profiles.
 *
 * Checks real failure modes found while building this conversion:
 *  - missing/duplicated `[section]` headers, or sections QX does not know
 *  - keys outside of any section (silently ignored by QX)
 *  - `#` used mid-line (QX only treats it as a comment at the start of a line,
 *    so a trailing comment turns the whole rule into garbage)
 *  - filter/rewrite/policy lines referencing a policy that does not exist
 *  - snapshot profile pointing at files that were not mirrored
 *
 *   bun tools/validate.mjs
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { ruleSig, sameTarget } from "./lib/rule-target.mjs";
import { resolveRepoBase } from "./repo-url.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ONLINE = join(ROOT, "QuantumultX", "default.conf");

/** Sections Quantumult X understands. Anything else is a fatal import error. */
const KNOWN_SECTIONS = new Set([
  "general",
  "dns",
  "policy",
  "server_local",
  "server_remote",
  "filter_local",
  "filter_remote",
  "rewrite_local",
  "rewrite_remote",
  "task_local",
  "http_backend",
  "mitm",
]);

/** Sections that may only appear once. */
const REQUIRED_SECTIONS = [...KNOWN_SECTIONS];

/** Quantumult X 接受的 rewrite 动作名（官方 sample.conf 的 [rewrite_local] 全集）。 */
const QX_REWRITE_ACTIONS = new Set([
  "reject", "reject-200", "reject-img", "reject-dict", "reject-array", "reject-drop",
  "302", "307",
  "script-request-header", "script-request-body", "script-response-header", "script-response-body",
  "script-echo-response", "script-analyze-echo-response",
  "request-header", "response-header", "request-body", "response-body",
  "jsonjq-request-body", "jsonjq-response-body",
  "echo-response",
]);

/** Rule types Quantumult X accepts in filter sections. */
const QX_RULE_TYPES = new Set([
  "host",
  "host-suffix",
  "host-keyword",
  "host-wildcard",
  "ip-cidr",
  "ip6-cidr",
  "ip-asn",
  "geoip",
  "user-agent",
  "url-regex",
  "final",
]);

const errors = [];
const warnings = [];

const err = (file, line, msg) => errors.push(`${file}:${line}: ${msg}`);
const warn = (file, line, msg) => warnings.push(`${file}:${line}: ${msg}`);

function parseProfile(path) {
  const text = readFileSync(path, "utf8");
  const lines = text.split(/\r?\n/);
  const sections = new Map();
  const seenHeader = new Map();
  const loose = [];
  let current = null;

  lines.forEach((raw, i) => {
    const n = i + 1;
    const line = raw.trim();

    if (line.startsWith("[") && line.endsWith("]")) {
      const name = line.slice(1, -1).trim();
      if (!KNOWN_SECTIONS.has(name)) err(path, n, `unknown section [${name}]`);
      if (seenHeader.has(name)) err(path, n, `duplicate section [${name}] (first at line ${seenHeader.get(name)})`);
      seenHeader.set(name, n);
      current = name;
      if (!sections.has(name)) sections.set(name, []);
      return;
    }

    if (line === "" || line.startsWith("#") || line.startsWith(";") || line.startsWith("//")) return;

    if (current === null) {
      loose.push({ n, line });
      return;
    }
    sections.get(current).push({ n, line });
  });

  return { path, text, sections, loose };
}

/**
 * QX only treats `#`/`;`/`//` as a comment when they start a line. A `#`
 * elsewhere is part of the value and usually breaks the rule.
 */
function checkStrayComments(p) {
  for (const [name, entries] of p.sections) {
    for (const { n, line } of entries) {
      const idx = line.indexOf("#");
      if (idx > 0) err(p.path, n, `'#' inside a value in [${name}] — QX would treat it as literal text: ${line.slice(0, 80)}`);
    }
  }
}

/**
 * [filter_remote] 的顺序有意义：谁先匹配谁决定去向。
 * 两条硬约束（来自 Loon 原配置与用户 QX 配置）：
 *   1. CN REGION 必须最后（Loon 注释明确「请勿修改远程 CN REGION 规则的排序」）；
 *   2. 广告拦截应在最前（用户 QX 配置如此；实测 42 个域名与 App 分流冲突）。
 */
function checkFilterOrder(p) {
  const order = (p.sections.get("filter_remote") ?? []).map((e) => e.line);
  if (!order.length) return;
  const tagOf = (l) => (l.match(/tag=([^,]+)/) ?? [])[1] ?? "";
  const tags = order.map((l) => tagOf(l).includes("CN REGION") ? "CN" : (l.startsWith("FILTER_REGION") ? "CN" : tagOf(l)));
  // Loon 原注释要求「请勿修改远程 CN REGION 规则的排序甚至删除」，
  // 即 CN REGION 必须在**所有走代理/规则的条目之后**（否则 CN 的 IP 会被后续条目抢走）。
  // 但纯 direct 的内置资源（LAN）排在其后无影响，故允许 LAN 跟在它后面。
  const cnIdx = tags.findIndex((t) => t === "CN");
  const after = tags.slice(cnIdx + 1).filter((t) => t !== "LAN");
  if (cnIdx !== -1 && after.length) {
    err(p.path, 0, `CN REGION 之后还有非 LAN 条目（第 ${cnIdx + 1}/${tags.length} 条，其后为 ${after.join(", ")}）—— Loon 原配置要求 CN REGION 必须在最后（LAN 除外）`);
  }
  // 广告拦截应尽量靠前（先匹配先赢）。
  // 注意 kelee 那批分流里本身就有一堆广告拦截器（BlockAdvertisers / Remove_ads_by_keli /
  // Block_HTTPDNS …），它们排在最前同样满足"广告拦截在前"的意图，所以判据放宽为
  // 「首个广告类条目出现在前 3 条内」，而不是只认名字含"广告拦截"的那一条。
  const isAds = (t) =>
    t.includes("广告") || t === "Advertising" || /HTTPDNS|Advertisers|可莉|广告平台/.test(t);
  const adsIdx = tags.findIndex(isAds);
  if (adsIdx === -1) {
    warn(p.path, 0, "没有找到广告拦截类条目（filter_remote 里应至少有一个 reject 型广告规则）");
  } else if (adsIdx > 2) {
    warn(p.path, 0, `广告拦截在第 ${adsIdx + 1} 条，建议放最前（与你的 QX 配置一致）`);
  }
}

/**
 * 本仓库自带规则文件（QuantumultX/rules/*）里引用的脚本 URL 必须指向本仓库。
 *
 * 否则「全部走本仓库」的目标就名不副实：上游删文件或被墙即静默失效，
 * 也不受快照兜底保护（真实踩过：JD 比价的两条脚本曾直链 githubdulong）。
 */
function checkLocalRuleScriptsAreSelfHosted(repoSlug) {
  const dir = join(ROOT, "QuantumultX", "rules");
  if (!existsSync(dir)) return 0;
  let checked = 0;
  // 必须**递归**：kelee 转换产物在 QuantumultX/rules/kelee/ 子目录。
  // 非递归时这批文件的脚本引用完全不参与校验（曾经就是因为这个，
  // 一个被孤儿清理删掉的镜像脚本没人发现 —— 规则指向 404 而 validate 全绿）。
  const files = readdirSync(dir, { recursive: true })
    .map((f) => String(f).replace(/\\/g, "/"))
    .filter((f) => /\.(snippet|list)$/.test(f));
  for (const f of files) {
    const rel = `QuantumultX/rules/${f}`;
    let text;
    try { text = readFileSync(join(dir, f), "utf8"); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/url(?:-and-header)?\s+script-\S+\s+(https?:\/\/\S+)/);
      if (!m) continue;
      const u = m[1].replace(/["'],$/, "");
      checked++;
      if (!u.includes(repoSlug)) {
        // kelee.one 的脚本对 CI 返回 403（Cloudflare 拦机器人），但设备端可取，
        // 因此是**有意保留**的例外 —— 只告警，不报错（与 Loon 行为一致）。
        if (/kelee\.one/i.test(u)) {
          warn(rel, 0, `脚本保留 kelee.one 原始地址（CI 取不到，设备端可用）: ${u.split("/").pop()}`);
        } else {
          err(rel, 0, `脚本 URL 未指向本仓库（上游失效即静默失败）: ${u.slice(0, 80)}`);
        }
        continue;
      }
      // 指向本仓库的脚本必须**真的存在**：镜像被清掉/改名后规则会指向 404。
      // （脚本 URL 可能带 `#片段`，片段不属于路径。）
      const idx = u.indexOf(`/${repoSlug}/`);
      const afterSlug = u.slice(idx + repoSlug.length + 2);
      const relPath = afterSlug.slice(afterSlug.indexOf("/") + 1).split("#")[0];
      if (relPath.startsWith("snapshot/") || relPath.startsWith("QuantumultX/")) {
        if (!existsSync(join(ROOT, relPath))) {
          err(rel, 0, `规则引用的仓库内脚本不存在（镜像被清理或改名）: ${relPath}`);
        }
      }
    }
  }
  return checked;
}

/** policy= / force-policy= / final must name an existing policy. */
function checkPolicyReferences(p) {
  const defined = new Set();
  const seen = new Map();
  for (const { n, line } of p.sections.get("policy") ?? []) {
    const m = line.match(/^(static|available|round-robin|dest-hash|url-latency-benchmark|ssid)\s*=\s*([^,]+)/);
    if (!m) continue;
    const name = m[2].trim();
    // Duplicate policy names make QX behaviour undefined, and are easy to
    // introduce when merging two configs that each define e.g. 香港节点.
    if (seen.has(name)) err(p.path, n, `duplicate policy "${name}" (first at line ${seen.get(name)})`);
    seen.set(name, n);
    defined.add(name);
  }
  const builtin = new Set(["direct", "reject", "proxy"]);

  const resolve = (name) => defined.has(name) || builtin.has(name);

  for (const [name, entries] of p.sections) {
    if (!["filter_local", "filter_remote", "rewrite_remote", "policy"].includes(name)) continue;
    for (const { n, line } of entries) {
      const fp = line.match(/(?:^|,)\s*force-policy=([^,]+)/);
      if (fp && !resolve(fp[1].trim())) err(p.path, n, `force-policy=${fp[1].trim()} is not defined in [policy]`);

      if (name === "filter_local") {
        // host, x.com, POLICY  /  final, POLICY
        const parts = line.split(",").map((s) => s.trim());
        if (parts[0].toLowerCase() === "final") {
          if (!resolve(parts[1])) err(p.path, n, `final target "${parts[1]}" is not defined in [policy]`);
        } else if (parts.length >= 3 && !resolve(parts[2])) {
          err(p.path, n, `rule references undefined policy "${parts[2]}"`);
        }
      }
    }
  }
}

/** filter_remote lines must be `url, key=value, ...`. */
function checkRemoteLines(p) {
  for (const name of ["filter_remote", "rewrite_remote", "server_remote"]) {
    for (const { n, line } of p.sections.get(name) ?? []) {
      const url = line.split(",")[0].trim();
      const builtinOk = /^(FILTER_REGION|FILTER_LAN)$/.test(url);
      if (!builtinOk && !/^https?:\/\//.test(url)) {
        err(p.path, n, `[${name}] entry does not start with an http(s) URL: ${url}`);
      }
      for (const kv of line.split(",").slice(1)) {
        const t = kv.trim();
        if (t && !/^[a-zA-Z_-]+=/.test(t)) err(p.path, n, `[${name}] malformed parameter "${t}"`);
        // 布尔参数必须是 true/false —— 曾生成 "opt-parser=undefined" 导致 QX 解析异常
        const bm = t.match(/^(enabled|opt-parser|inserted-resource)=(.*)$/);
        if (bm && bm[2] !== "true" && bm[2] !== "false") {
          err(p.path, n, `[${name}] ${bm[1]} 必须是 true 或 false，实际是 "${bm[2]}"`);
        }
      }
    }
  }
}

/** task_local lines must be `schedule url, key=value, ...`. */
function checkTasks(p) {
  const schedules = /^(?:\*|\d|event-network|event-interaction)/;
  for (const { n, line } of p.sections.get("task_local") ?? []) {
    const head = line.split(",")[0].trim();
    if (!schedules.test(head)) err(p.path, n, `[task_local] entry does not start with a schedule: ${head.slice(0, 60)}`);
    const target = head.split(/\s+/).pop();
    if (!/^(https?:\/\/|.*\.js$)/.test(target)) err(p.path, n, `[task_local] target is not a script URL: ${target}`);
  }
}

/**
 * Self-hosted URLs (pointing back at this repo) must resolve to a real file.
 * Catches path/prefix mistakes such as emitting `/rules/x.list` while the file
 * lives at `QuantumultX/rules/x.list` — which would silently drop those rules
 * in Quantumult X.
 */
function checkSelfHostedFiles(p, repoSlug) {
  const seen = new Set();
  for (const [name, entries] of p.sections) {
    for (const { n, line } of entries) {
      for (const m of line.matchAll(/https:\/\/raw\.githubusercontent\.com\/[^,\s]+\/([^,\s]+)/g)) {
        const url = m[0];
        if (!url.includes(`/${repoSlug}/`)) continue; // not self-hosted
        // Strip the "<repoSlug>/<ref>/" prefix to get the in-repo path.
        const idx = url.indexOf(`/${repoSlug}/`);
        const afterSlug = url.slice(idx + repoSlug.length + 2);
        const slash = afterSlug.indexOf("/");
        // 脚本 URL 可以带 `#key=value` 参数片段（kelee 转换器用它内联插件参数）。
        // 片段不是路径的一部分；若不去掉，这里会拼出一个不存在的文件名而误报，
        // 更糟的是 fetch-snapshot 的孤儿扫描会因此漏认引用、把该脚本删掉（实测踩过）。
        const hash = afterSlug.indexOf("#");
        const rel = (hash === -1 ? afterSlug : afterSlug.slice(0, hash)).slice(slash + 1);
        if (seen.has(rel)) continue;
        seen.add(rel);
        if (!existsSync(join(ROOT, rel))) {
          err(p.path, n, `self-hosted URL points at a missing file: ${rel} (in [${name}])`);
        }
      }
    }
  }
  return seen.size;
}

/**
 * Vendored rules must be valid Quantumult X filter syntax, not HTML error pages
 * or unconverted Loon rules. A wrong file would silently produce zero rules.
 */
function checkVendoredRules() {
  const dir = join(ROOT, "QuantumultX", "rules");
  if (!existsSync(dir)) return 0;
  // 同时覆盖 .list 与 .snippet（插件提取重写是 .snippet，此前被漏检）
  // 必须**递归**：转换产物在 QuantumultX/rules/kelee/ 子目录。
  // 非递归会让这 54 个文件完全绕过语法校验 —— 实测非法的 `host, x, reject-drop`
  // 分流策略（QX 分流只认 reject/direct/proxy）就是这样在 0 error 下通过的。
  const files = readdirSync(dir, { recursive: true })
    .map((f) => String(f).replace(/\\/g, "/"))
    .filter((f) => /\.(list|snippet|conf)$/.test(f))
    // `_hostnames.conf` / `_conversion-report.json` 是辅助产物，不是规则集
    .filter((f) => !f.split("/").pop().startsWith("_"));
  let total = 0;
  for (const f of files) {
    const rel = `QuantumultX/rules/${f}`;
    const lines = readFileSync(join(dir, f), "utf8").split(/\r?\n/);
    let count = 0;
    let hasHostnameInFile = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      // Must be "<type>, <value>[, policy]" with a QX type.
      // hostname 行是重写资源的 MITM 声明，不是分流规则 —— 单独校验，不计入规则数。
      if (/^hostname\s*=/i.test(line)) {
        const hostList = line.split("=", 2)[1].split(",").map((x) => x.trim()).filter(Boolean);
        const badH = hostList.filter((x) => !/^[A-Za-z0-9*?._-]+$/.test(x));
        if (badH.length) err(rel, 0, `hostname 含非法条目: ${badH.slice(0, 3).join(", ")}`);
        hasHostnameInFile = true;
        continue;
      }
      // 重写规则写作 "<regex> url <action> [arg]" —— 与分流规则是两套语法。
      if (/\surl(?:-and-header)?\s+\S/.test(line)) {
        const isHeaderForm = /\surl-and-header\s+\S/.test(line);
        const act = line.match(/\surl(?:-and-header)?\s+(\S+)/)[1].toLowerCase();
        if (!QX_REWRITE_ACTIONS.has(act)) {
          err(rel, 0, `未知的重写动作 "${act}": "${line.slice(0, 60)}"`);
        }
        // jq-path="..." 是 Loon 的外部 jq 写法，QX 求值会失败
        if (/jq-path\s*=|jq_file\s*=/i.test(line)) {
          err(rel, 0, `含 jq-path=/jq_file= 的非法 jq 表达式（QX 会失效）: ${line.slice(0, 60)}`);
        }
        if (isHeaderForm) {
          // url-and-header 的“正则”部分**本来就含空格**：`<re> \r\nUser-Agent: <ua>`
          // （官方 sample.conf 就是这个形状）。所以此处只校验正则段本身。
          const pat = line.replace(/\s+\\r\\n[\s\S]*$/, "");
          if (!/^[\x20-\x7e]+$/.test(pat) || /,/.test(pat)) {
            err(rel, 0, `url-and-header 的 URL 正则含非 ASCII 或逗号: ${pat.slice(0, 60)}`);
          }
          // header 段必须带 User-Agent: 之类的真实条件，否则等于无条件
          const hdr = line.slice(pat.length);
          if (!/\\r\\n\s*[A-Za-z-]+:/.test(hdr)) {
            err(rel, 0, `url-and-header 缺少 header 条件（形如 \\r\\nUser-Agent: ...）: ${line.slice(0, 70)}`);
          }
        } else {
          // URL 正则必须只含 ASCII 且**不含空白**（空白才是字段分隔符）。
          // 早先还检查了逗号，但那是错的：URL 查询串里合法地含逗号
          // （如 `x-oss-process=image/resize,m_fill,w_1\\d{3},h_2\\d{3}`），
          // 会把一批正常规则误报成"上游破损行"（实测 5 条）。
          // 真正的结构性不变量是「正则是单个无空白 token」。
          const pat = line.replace(/\s+url\s+[\s\S]*$/, "");
          if (!/^[\x20-\x7e]+$/.test(pat) || /\s/.test(pat)) {
            err(rel, 0, `URL 正则含非 ASCII 或空白（上游破损行）: ${pat.slice(0, 60)}`);
          }
        }
        count++;
        continue;
      }
      // Surge/Loon 关键字出现在预转换产物里 = 转换漏做，QX 会静默丢弃这些规则。
      // （真实踩过：AWAvenue 的文件名含 QuantumultX 但内容是 Surge 语法）
      const surgeKw = line.split(",")[0].trim();
      if (/^(DOMAIN|DOMAIN-SUFFIX|DOMAIN-KEYWORD|IP-CIDR6|URL-REGEX|RULE-SET)$/i.test(surgeKw)) {
        err(rel, 0, `预转换产物里出现 Surge/Loon 关键字 "${surgeKw}"（QX 不认，会被静默丢弃）: ${line.slice(0, 60)}`);
        continue;
      }
      const type = line.split(",")[0].trim().toLowerCase();
      if (!QX_RULE_TYPES.has(type)) {
        err(rel, 0, `not a valid Quantumult X rule type: "${line.slice(0, 60)}"`);
        continue;
      }
      // Field 3 must be a policy (or `no-resolve`-like option QX actually knows).
      // Guards against options landing in the policy slot — QX has no `no-resolve`,
      // and a mis-placed option silently breaks the rule.
      if (/^(ip-cidr|ip6-cidr|geoip|ip-asn)$/.test(type)) {
        const fields = line.split(",").map((x) => x.trim());
        const pol = fields[2];
        if (!pol) {
          err(rel, 0, `CIDR/ASN rule has no policy in field 3: "${line.slice(0, 60)}"`);
        } else if (/^(no-resolve|force-cellular|multi-interface|via-interface)/i.test(pol)) {
          err(rel, 0, `option "${pol}" is in the policy slot (Quantumult X expects the policy there): "${line.slice(0, 60)}"`);
        }
      }
      count++;
    }
    // 纯重写文件（如京东比价）只有 url 规则 + hostname，没有分流规则，属正常。
    const hasRewrite = lines.some((l) => /\surl(?:-and-header)?\s+\S/.test(l));
    // My.list / My.snippet 是用户的**个人合并来源**，允许暂时为空（只放注释），
    // 空了照样作为 merges[0] 参与合并 —— 不算错误。
    const isPersonal = /(^|\/)My\.(list|snippet)$/.test(rel);
    if (count === 0 && !hasRewrite && !isPersonal) err(rel, 0, "vendored 文件既无分流规则也无重写规则");
    total += count;
  }
  return { files: files.length, rules: total };
}

/**
 * 跨重写源检测「同一响应体被重复处理」。
 *
 * 这是本项目踩过的真坑：从插件提取的规则与 fmz 聚合资源大量重叠（实测 1454 条），
 * 两条同时启用时，同一个响应体会被两个 script-response-body 依次处理，结果不可预期。
 * QX 自己不会报错，所以必须在提交前拦住。
 *
 * 检查范围：每一个已启用的重写源（上游的从 snapshot 读，本仓库自带的直接读）。
 */
function checkRewriteDuplicates() {
  const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));

  const seen = new Map(); // 规则键 -> 来源文件
  const seenSigs = []; // {sig, line, from} 仅脚本/jsonjq 类
  let dupes = 0;

  for (const r of src.rewrites) {
    if (!r.enabled) continue;
    let file = null;
    if (r.local_file) {
      file = join(ROOT, r.local_file);
    } else {
      const m = (r.url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
      if (m) {
        const cand = join(ROOT, "snapshot", "github.com", m[1]);
        if (existsSync(cand)) file = cand;
      }
    }
    if (!file || !existsSync(file)) continue; // 无本地副本（如 releases 直链）则跳过

    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const t = raw.trim();
      if (!t || t.startsWith("#") || !/\surl\s/.test(t)) continue;
      // 会「处理请求/响应体」的动作重复才是危险的：脚本类 + jsonjq 类。
      // 注意：jsonjq-response-body / jsonjq-request-body 同样改写 body，
      // 两条命中同一 URL 时会先后各跑一次（曾漏掉这类，见本次修复说明）。
      if (!/url\s+(script-|jsonjq-)/.test(t)) continue;
      const key = t;
      const from = (relative(ROOT, file) || file).replace(/\\/g, "/");
      const pat = t.split(/\s+url\s+/)[0];
      const sig = ruleSig(pat);

      // ① 整行完全相同：最明显的重复
      if (seen.has(key) && seen.get(key) !== from) {
        err("tools/sources.json", 0, `同一脚本重写同时来自两个源（响应体会被处理两次）:\n      ${t.slice(0, 90)}\n      ${seen.get(key)}  <->  ${from}`);
        dupes++;
      } else if (!seen.has(key)) {
        seen.set(key, from);
      }
      // ② 语义重复：正则写法不同、但命中同一 URL 的 body 改写
      const clash = seenSigs.find((e) => e.from !== from && sameTarget(sig, e.sig));
      if (clash) {
        err("tools/sources.json", 0, `同一 URL 被两个源用不同正则重复处理（响应体会被处理两次）:\n      ${pat.slice(0, 90)}\n      ${clash.from}  <->  ${from}`);
        dupes++;
      } else {
        seenSigs.push({ sig, line: t, from });
      }
    }
  }
  return dupes;
}

/**
 * 本地重写资源若含脚本/jsonjq 规则，必须自带 hostname。
 *
 * 这是本项目踩过的坑：从插件提取的规则里大部分是脚本类与 jsonjq 类，
 * 而 QX 依赖 rewrite_remote 资源自带的 hostname 才会把这些主机名并入 MITM。
 * 缺了 hostname 行，规则**不报错、也不生效** —— 属于最难发现的一类失效。
 */
function checkRewriteHostnames() {
  const dir = join(ROOT, "QuantumultX", "rules");
  let checked = 0;
  // 必须**递归**且同时接受 .conf：kelee 转换产物是 QuantumultX/rules/kelee/*.conf，
  // 只扫顶层 .snippet 的话它们一个都不被检查（实测打印「…的文件: 1」就是这个盲区）。
  // 这一条在 [mitm] 不再写全局 hostname 之后变得**关键**：资源自带的 hostname
  // 是 MITM 覆盖的唯一来源，漏写就等于静默失效。
  const files = existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map((f) => String(f).replace(/\\/g, "/"))
        .filter((f) => /\.(snippet|list)$/.test(f) && !f.split("/").pop().startsWith("_"))
    : [];
  const rels = files.map((f) => `QuantumultX/rules/${f}`);

  // 还要覆盖 **snapshot 直链**的重写资源（sources.rewrites 里没有 local_file 的那些，
  // 如 bm7 的 BlockHTTPDNS.conf / Advertising.conf、fmz 的 rewrite.snippet、
  // chavyleung 的 boxjs、NSRingo 的 WeatherKit）。它们不在 QuantumultX/rules/ 下，
  // 若只扫前者，某个上游哪天删掉 hostname 行就会**静默失明**。
  try {
    const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));
    for (const r of src.rewrites ?? []) {
      if (!r.enabled || r.local_file) continue;
      const m = (r.url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
      const cand = m
        ? join(ROOT, "snapshot", "github.com", m[1])
        : (() => {
            const m2 = (r.url ?? "").match(/^https:\/\/([^/]+)\/(.+)$/);
            return m2 ? join(ROOT, "snapshot", "host", m2[1], m2[2]) : null;
          })();
      if (cand && existsSync(cand)) rels.push(relative(ROOT, cand).replace(/\\/g, "/"));
    }
  } catch { /* sources.json 读不到时上面的本地文件检查仍然有效 */ }

  for (const rel of rels) {
    let text;
    try { text = readFileSync(join(ROOT, rel), "utf8"); } catch { continue; }
    const lines = text.split(/\r?\n/);
    const hasHostname = lines.some((l) => /^hostname\s*=/i.test(l.trim()));
    // 只统计「需要 MITM 才能工作」的规则
    const needsMitm = lines.filter((l) => /\surl\s+(script-|jsonjq-)/.test(l)).length;
    if (needsMitm > 0 && !hasHostname) {
      err(rel, 0, `含 ${needsMitm} 条 script/jsonjq 规则但缺少 hostname 行 —— 这些规则不会生效（且不报错）`);
    }
    if (needsMitm > 0) checked++;
  }
  return checked;
}

/** Non-empty requirement: essential sections must carry real content. */
function checkNonEmpty(p) {
  for (const name of ["general", "dns", "policy", "filter_local", "filter_remote", "rewrite_remote"]) {
    const entries = p.sections.get(name) ?? [];
    if (entries.length === 0) err(p.path, 0, `[${name}] is empty`);
  }
}

/**
 * 已生成、但没有任何 [filter_remote]/[rewrite_remote] 条目引用的资源文件。
 *
 * 这次真实踩过：清理「被取代条目」时按 tag 删除，结果把新生成的 kelee 条目
 * 连同同名的社区条目一起删掉 —— 京东比价、高德、微博、B站 的**响应体重写全部消失**，
 * 而缺条目不产生任何错误，validate 依旧 0 error 全绿。
 * 所以必须反向检查「磁盘上的规则文件是否都有人引用」。
 */
function checkOrphanedRuleFiles(p) {
  const dir = join(ROOT, "QuantumultX", "rules");
  if (!existsSync(dir)) return 0;
  // 直接找「行里是否出现 QuantumultX/rules/<相对路径>」——生成的是自托管绝对 URL，
  // 中间夹着分支名（.../proxy-profile/master/QuantumultX/rules/...），
  // 用 slug 正则去截会把分支名一起captured，匹配不到。
  const lines = [];
  for (const name of ["filter_remote", "rewrite_remote"]) {
    for (const e of p.sections.get(name) ?? []) lines.push(e.line);
  }
  // 合并的**输入**也算被引用：它们不再作为 rewrite_remote 条目出现，
  // 而是被 sources.json 的 merges[].local_file 引用（如 kelee/BlockAdvertisers.conf
  // 是「广告拦截合集MAX」的来源之一）。不认的话会被误报成"无人引用"。
  try {
    const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));
    for (const arr of [src.rewrites, src.filters]) {
      for (const e of arr ?? []) {
        for (const m of e.merges ?? []) if (m.local_file) lines.push(m.local_file);
        if (e.local_file) lines.push(e.local_file);
      }
    }
  } catch { /* 读不到 sources.json 时仍按已解析的段判定 */ }
  const blob = lines.join("\n");
  let orphans = 0;
  for (const f of readdirSync(dir, { recursive: true })) {
    const s = String(f).replace(/\\/g, "/");
    if (!/\.(conf|list|snippet)$/.test(s)) continue;
    const base = s.split("/").pop();
    if (base.startsWith("_")) continue; // _hostnames.conf 等辅助产物，本就不需要被引用
    if (blob.includes(`QuantumultX/rules/${s}`)) continue;
    orphans++;
    err(p.path, 0, `规则文件已生成但无人引用（功能等同被删除）: QuantumultX/rules/${s}`);
  }
  return orphans;
}

// ---- run -------------------------------------------------------------------
// Resolved so self-hosted URLs can be recognised regardless of which machine or
// CI job runs the check.
const repoSlug = resolveRepoBase(ROOT).slug;

{
  const localScripts = checkLocalRuleScriptsAreSelfHosted(resolveRepoBase(ROOT).slug);
  console.log(`本仓库规则文件的脚本 URL  已校验: ${localScripts}`);
  const vendored = checkVendoredRules();
  if (vendored) console.log(`QuantumultX/rules  ${vendored.files} file(s), ${vendored.rules} rules`);
  const dupes = checkRewriteDuplicates();
  console.log(`重写去重检查  跨源重复脚本重写: ${dupes}`);
  const hn = checkRewriteHostnames();
  console.log(`MITM 主机名检查  含脚本规则且自带 hostname 的文件: ${hn}`);
}
const profiles = [ONLINE].filter((p) => {
  if (!existsSync(p)) {
    err(p, 0, "profile does not exist");
    return false;
  }
  return true;
});

for (const path of profiles) {
  const p = parseProfile(path);
  const rel = relative(ROOT, path).replace(/\\/g, "/");

  for (const { n, line } of p.loose) {
    err(rel, n, `line outside any section (QX ignores it): ${line.slice(0, 70)}`);
  }
  checkStrayComments({ ...p, path: rel });
  checkPolicyReferences({ ...p, path: rel });
  checkRemoteLines({ ...p, path: rel });
  checkTasks({ ...p, path: rel });
  checkNonEmpty({ ...p, path: rel });
  checkFilterOrder({ ...p, path: rel });

  // 段头必须全部存在 —— Quantumult X 会因为缺少某个模块而拒绝导入
  // （真实踩过：[server_local] 缺失 -> 导入报「缺少模块 server_local」）。
  // 段内可以为空，但段头不能少。
  const missing = REQUIRED_SECTIONS.filter((s) => !p.sections.has(s));
  for (const s of missing) err(rel, 0, `缺少段头 [${s}] —— Quantumult X 会因缺少该模块而无法导入`);


  const selfHosted = checkSelfHostedFiles({ ...p, path: rel }, repoSlug);
  const orphans = checkOrphanedRuleFiles({ ...p, path: rel });

  const counts = [...p.sections].map(([k, v]) => `${k}:${v.length}`).join(" ");
  console.log(`${rel}  ${counts}${selfHosted ? `  self-hosted:${selfHosted}` : ""}`);
}

// Rule-count sanity: the snapshot must not be an empty mirror.
if (existsSync(join(ROOT, "snapshot", "index.json"))) {
  const idx = JSON.parse(readFileSync(join(ROOT, "snapshot", "index.json"), "utf8"));
  console.log(`snapshot/index.json  ${idx.mirrored}/${idx.total} mirrored, ${idx.failed} failed`);
  if (idx.failed > 0) {
    for (const r of idx.resources.filter((x) => x.error)) {
      // 引用脚本失效（上游已 404）不影响规则可用，只告警
      if (r.kind === "js") warn("snapshot/index.json", 0, `引用脚本取不到（上游可能已删）: ${r.url}`);
      else err("snapshot/index.json", 0, `failed: ${r.url} (${r.error})`);
    }
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`ERROR ${e}`);
  console.error(`\n${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`\nOK — 0 errors, ${warnings.length} warning(s)`);
