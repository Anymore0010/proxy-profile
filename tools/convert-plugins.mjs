#!/usr/bin/env bun
/**
 * Loon 插件（.lpx）-> Quantumult X 重写/分流资源 转换器。
 *
 * 输入： vendor/loon-plugins/*.lpx（tools/fetch-plugins.mjs 抓的源配置原样副本）
 * 输出： QuantumultX/rules/rewrite/kelee/<plugin>.snippet —— 重写资源（rewrite_remote）
 *        QuantumultX/rules/filter/kelee/<plugin>.list    —— 分流资源（filter_remote）
 *        QuantumultX/rules/kelee/_hostnames.conf —— 汇总的 hostname 行
 *        QuantumultX/rules/rewrite/kelee/_conversion-report.json —— 统计与跳过明细
 *
 * 目标：尽可能**完整复刻**源 Loon 插件的行为（用户明确要求），而不是"功能差不多"。
 * 因此能映射的一律映射；映射不了的一律**逐条记账**到报告，绝不静默丢弃。
 *
 * 用法： bun tools/convert-plugins.mjs [--check]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ruleSig, sameTarget } from "./lib/rule-target.mjs";
import { resolveRepoBase } from "./repo-url.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "loon-plugins");
// 产物按用途分目录：重写放 rules/rewrite/kelee/，分流放 rules/filter/kelee/。
const OUT_REWRITE = join(ROOT, "QuantumultX", "rules", "rewrite", "kelee");
const OUT_FILTER = join(ROOT, "QuantumultX", "rules", "filter", "kelee");
const CHECK = process.argv.includes("--check");
const repoBase = resolveRepoBase(ROOT).rawBase;

/** kelee.one 与 GitHub 的脚本一律镜像进本仓库后引用（kelee.one 对 QX 的 UA 不可靠）。 */
const UA = { "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0", accept: "*/*", "accept-language": "zh-CN,zh-Hans;q=0.9" };

/**
 * 这些插件**不产出**文件（用户明确从配置里去掉 / 已由合并条目覆盖）。
 * 不加跳过清单的话，转换器每轮都会重新生成它们 -> validate 的孤儿检查报错 ->
 * CI 红绿循环（实测出现过）。
 */
const SKIP_PLUGINS = new Set([
  "LoonGallery.lpx",     // 用户去掉（插件仓库）
  "QuickSearch.lpx",     // 用户去掉（快捷搜索）
  "iRingo.WeatherKit.lpx", // 用户去掉，保留社区版 iRingo WeatherKit
]);

const skipReport = [];
const pluginReport = [];
const notes = [];
const inlinedArgs = []; // 成功内联的插件参数（记进报告，便于核对）

/**
 * 分流（[filter_remote]）策略名。
 * ⚠ reject-drop / reject-200 之类是**重写动作**，不是分流策略 ——
 * QX 分流只认 reject / direct / proxy / 策略组名。
 * 曾把 REJECT-DROP 原样写成分流策略，生成 `host, x, reject-drop` 这种非法行。
 */
const FILTER_POLICY = {
  REJECT: "reject",
  "REJECT-DICT": "reject",
  "REJECT-200": "reject",
  "REJECT-ARRAY": "reject",
  "REJECT-IMG": "reject",
  "REJECT-DROP": "reject",
  "REJECT-NO-DROP": "reject",
  DIRECT: "direct",
  PROXY: "proxy",
};

/** 重写（[rewrite_local]）动作名。 */
const REWRITE_ACTION = {
  REJECT: "reject",
  "REJECT-DICT": "reject-dict",
  "REJECT-200": "reject-200",
  "REJECT-ARRAY": "reject-array",
  "REJECT-IMG": "reject-img",
  "REJECT-DROP": "reject-drop",
  "REJECT-NO-DROP": "reject",
};

/** Loon 分流类型 -> QX 分流类型。 */
const RULE_MAP = {
  DOMAIN: "host",
  "DOMAIN-SUFFIX": "host-suffix",
  "DOMAIN-KEYWORD": "host-keyword",
  "DOMAIN-WILDCARD": "host-wildcard",
  "IP-CIDR": "ip-cidr",
  "IP-CIDR6": "ip6-cidr",
  GEOIP: "geoip",
  "USER-AGENT": "user-agent", // QX 官方 sample.conf 的 [filter_local] 里有 user-agent
};

function sectionLines(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `[${name.toLowerCase()}]`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out;
}

function cleanRule(line) {
  if (/^\s*[#;]/.test(line)) return null;
  const s = line.replace(/\s*#.*$/, "").trim();
  return s.length ? s : null;
}

const skip = (plugin, section, line, reason) => skipReport.push({ plugin, section, line, reason });
const stripQuotes = (s) => s.trim().replace(/^["']|["']$/g, "");


// ---------------------------------------------------------------- 重写

/**
 * `a.b c.d` -> `del(.a.b, .c.d)`
 *
 * ⚠ 路径段必须逐段判断是否需要用 jq 的 `["..."]` 形式：
 * jq 的 `.foo-bar` 会被解析成**减法**（`.foo - bar`），`.2025` 也不是合法标识符。
 * 实测踩到：夸克的 `result.quark-countdown-2025` 原先原样输出，
 * 整个 `del(...)` 表达式变成非法 jq，QX 解析失败（该行还有 703 个路径，27158 字符）。
 * 规则：仅 `[A-Za-z_][A-Za-z0-9_]*` 可用 `.name`，其余一律 `["..."]`。
 */
const jqPath = (path) =>
  path
    .split(".")
    .map((seg) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg)
        ? `.${seg}`
        : `[${JSON.stringify(seg)}]`,
    )
    .join("");
/** `a.b c.d` -> `del(.a.b, .c.d)` */
const jsonDelToJq = (paths) => `'del(${paths.map(jqPath).join(", ")})'`;

/**
 * QX 的 rewrite 是**单行**解析的，超长行会被判「不合法」（实测：夸克 703 个路径的
 * 单个 `del(...)` 有 27161 字符，QX 只报「第一行不合法」且看不到细节）。
 * 参照野生 QX 资源的分布 —— 32 条 jsonjq 规则里最长 403 字符 —— 把超长表达式**拆成
 * 多条同 URL 的规则**（QX 对同 URL 的多条 body 重写是顺序生效的，语义等价）。
 *
 * 阈值取 100 个路径/条：实测约 3.8K 字符，仍比野生极限大一个数量级但远离 27K。
 */
const JQ_PATHS_PER_RULE = 100;

/** 路径 token（`result.a.b` / `result["a-b"]`）-> 段数组，供生成的脚本按段删除。 */
function pathSegments(token) {
  const out = [];
  const re = /\.([A-Za-z_$][\w$]*)|\["((?:[^"\\]|\\.)*)"\]|\[(\d+)\]/g;
  let m;
  let s = token.startsWith(".") ? token : `.${token}`;
  re.lastIndex = 0;
  while ((m = re.exec(s))) out.push(m[1] ?? JSON.parse(`"${m[2]}"`) ?? Number(m[3]));
  return out;
}

/**
 * 删除脚本源码：`$response.body` 里按段删除给定路径。
 *
 * 为什么不拆成多条同 URL 的 jsonjq 规则：本仓库 validate 的注释与实测都指出，
 * **同 URL 的多条 body 重写「先后各跑一次」的结果不可预期**（甚至后者永不执行）——
 * 拆开等于赌 QX 会全部执行。而单条 27161 字符的 jsonjq 已被证明超出 QX 单行上限。
 * 所以改走「一条 script-response-body + 镜像脚本」，与 mock 脚本同一套机制（已验证可行）。
 */
function jsonDelScriptSource(paths) {
  const rows = paths.map((p) => JSON.stringify(pathSegments(p))).join(",\n  ");
  return [
    "// 由 tools/convert-plugins.mjs 生成：删除响应体里的指定路径（替代超长的 jsonjq del(...)）。",
    "// 来源：Loon 插件的 response-body-json-del 动作。",
    "const PATHS = [",
    `  ${rows},`,
    "];",
    "function isObj(v) { return v !== null && typeof v === 'object'; }",
    "function delPath(root, segs) {",
    "  let cur = root;",
    "  for (let i = 0; i < segs.length - 1; i++) {",
    "    if (!isObj(cur)) return;",
    "    cur = cur[segs[i]];",
    "  }",
    "  if (!isObj(cur)) return;",
    "  const last = segs[segs.length - 1];",
    "  if (Array.isArray(cur)) { const n = Number(last); if (!Number.isNaN(n)) cur.splice(n, 1); }",
    "  else delete cur[last];",
    "}",
    "try {",
    "  const obj = JSON.parse($response.body);",
    "  for (const p of PATHS) delPath(obj, p);",
    "  $done({ body: JSON.stringify(obj) });",
    "} catch (e) { $done({}); }",
    "",
  ].join("\n");
}

/** 把路径表落成脚本并返回 `script-response-body <URL>`，与 mock 脚本共用确定性命名。 */
function materializeScript(pattern, source) {
  const hash = createHash("sha1").update(pattern + "\u0000" + source).digest("hex").slice(0, 12);
  const rel = `QuantumultX/rules/rewrite/kelee/mock/${hash}.js`;
  const abs = join(ROOT, rel);
  if (!CHECK) {
    mkdirSync(dirname(abs), { recursive: true });
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== source) writeFileSync(abs, source);
  }
  usedMocks.add(rel);
  return `${pattern} url script-response-body ${repoBase}/${rel}`;
}

function echoScriptSource(bodyLiteral, isBinary) {
  const head = [
    "// 由 tools/convert-plugins.mjs 生成：为 QX `script-echo-response` 返回固定 body。",
    "// 不能改用 `echo-response` —— 它的正文只接受本机 Data 目录里的文件，远程配置投递不了。",
    "// 来源：Loon 插件的 mock-response-body / response.body.mock(...) 动作。",
  ];
  if (isBinary) {
    // ⚠ QX 的 `body` 字段是**字符串**，塞 Uint8Array 会被 stringify 成 "[object Uint8Array]"。
    // 二进制必须用 `bodyBytes` + ArrayBuffer —— 本仓库既有脚本（dianping.js / spotify-proto.js /
    // baidumap.js）全部这么写。这些 mock body 只有 5~38 字节，直接内联字节字面量，
    // 不用 atob（QX 跑 JavaScriptCore，atob 不保证存在）。
    return [
      ...head,
      `const bytes = [${bodyLiteral}];`,
      "const buf = new ArrayBuffer(bytes.length);",
      "const view = new Uint8Array(buf);",
      "for (let i = 0; i < bytes.length; i++) view[i] = bytes[i];",
      "if (typeof $done === 'function') { $done({ bodyBytes: buf }); }",
      "",
    ].join("\n");
  }
  return [
    ...head,
    `const body = ${bodyLiteral};`,
    "if (typeof $done === 'function') { $done({ body: body }); }",
    "",
  ].join("\n");
}

/** 按顶层逗号切参数（忽略引号/反引号/括号内的逗号）。 */
/**
 * QX `echo-response` 的正文必须是**本机 Data 目录里的文件名**，不接受 URL / data: URI /
 * 内联内容 —— 凡带 scheme 的一律被判无效（KOP-XIAO resource-parser.js:3609-3614 原文：
 * 「echo-response 需要本机 Data 目录中的正文文件，不能直接引用 URL/URI」；
 * 官方 sample.conf：「the body file should be saved at "On My iPhone - Quantumult X - Data"」）。
 * 远程配置**投递不了本机文件**，所以这类规则写出来等于没写（静默失效）。
 *
 * 因此改走 `script-echo-response <本仓库镜像脚本URL>`：脚本里 `$done({body: …})` 返回固定
 * body。脚本经 URL 引用在 QX 是可行的（kelee 脚本管线已跑通），body 文件则不行。
 *
 * 生成物落在 QuantumultX/rules/rewrite/kelee/mock/<slug>.js，由调用方镜像进仓库。
 */

function splitArgs(s) {
  const out = [];
  let depth = 0, cur = "", q = null;
  for (const ch of s) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; cur += ch; continue; }
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 抓回 Loon 外链 .jq 并折叠成 QX 可用的单行表达式（剥注释、压空白、转义单引号）。 */
async function inlineJqFile(url, plugin, line) {
  const buf = await fetchAsset(url);
  if (!buf) { skip(plugin, "Rewrite", line, `jq 文件取不到（${url}）`); return null; }
  const inline = buf
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s*#.*$/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/'/g, "'\\''");
  if (!inline) { skip(plugin, "Rewrite", line, "jq 文件折叠后为空"); return null; }
  return inline;
}

/**
 * 把 jq 的 `X | IN(a, b, c)` 改写成 `X == a or X == b or X == c`。
 *
 * 为什么：QX 的 jsonjq 是**受限实现**，不是完整 jq。实测扫遍仓库里所有 QX 原生资源
 * （bm7 / fmz / sub-store 等，31 条 jsonjq 规则），用过函数只有
 * `del / map / select / if / test / has` + `and / or / |=` —— **`IN(` 一次都没出现**；
 * 而我们转换产物里有 5 处 `IN(`（拼多多 / 知乎 / 哔哩哔哩）。
 * 用户实测「拼多多底部按钮仍不生效」，而该表达式在完整 jq（python-jq）里求值正确，
 * 说明差异在**引擎能力**而非表达式逻辑 —— `IN` 是被怀疑的元凶。
 * `==` + `or` 是原生资源里出现过的写法，语义与 `IN` 等价。
 */
function rewriteInToOr(expr) {
  // 只处理 `| IN(...)` 形态（IN 的左输入就是它前面那一段，需回退到上一个 `|` 或 `(`）
  let out = expr;
  for (let guard = 0; guard < 20; guard++) {
    const i = out.indexOf("| IN(");
    if (i < 0) break;
    // 找左操作数起点：向前回退到最近的 `|` / `(` / `del(` 的边界
    let s = i - 1;
    while (s >= 0 && !/[|(,]/.test(out[s])) s--;
    s = s < 0 ? 0 : s + 1;
    const lhs = out.slice(s, i).trim();
    // 匹配 IN(...) 的结束括号
    let d = 0, e = i + 4;
    for (let j = i + 4; j < out.length; j++) {
      if (out[j] === "(") d++;
      else if (out[j] === ")") { d--; if (d === 0) { e = j; break; } }
    }
    const args = out.slice(i + 5, e);
    if (!lhs) break;
    const parts = args.split(",").map((x) => x.trim()).filter(Boolean);
    if (!parts.length) break;
    // `if COND | IN(...) then …` 形态：条件里必须保留 `if`，比较链加括号
    const isIfCond = /^if\s+/.test(lhs);
    const bare = isIfCond ? lhs.replace(/^if\s+/, "") : lhs;
    const cmp = parts.map((a) => `${bare} == ${a}`).join(" or ");
    // `if` 形态必须补上右括号：`if (A or B)`，否则 `then` 前缺 `)`
    const repl = isIfCond ? `if (${cmp})` : cmp;
    out = out.slice(0, s) + repl + out.slice(e + 1);
  }
  return out;
}

/** 把 `a b c` 拆成 (search, replace)：QX 的 response-body 需要成对的两段，且都不得含空白。 */
function splitTwoFields(rest) {
  const s = rest.trim();
  // 常见形式：`<search> <replace>`（QX 里两段都不能含空白，所以用第一个空白切）
  const i = s.indexOf(" ");
  if (i < 0) return { search: s, replace: "" };
  return { search: s.slice(0, i), replace: s.slice(i + 1).trim() };
}

/**
 * Loon 条件重写 `request|response if ${url} ~= /re/ then <动作>` -> QX 单行重写。
 *
 * 条件本身就是 URL 正则，而 QX 的每行重写天然「只对匹配该正则的 URL 生效」——
 * 所以语义等价：pattern 用条件里的正则，动作部分走同一套动作转换。
 * `@` 取反 / 多条件 AND 的写法仍然跳过（QX 无法表达）。
 */
async function convertIfThen(rawPat, op, thenPart, plugin, line) {
  if (op !== "~=") {
    // `== "https://exact/url"` -> 等价的正则（转义后首尾锚定）
    if (op === "==" && rawPat.startsWith('"') && rawPat.endsWith('"')) {
      const url = rawPat.slice(1, -1);
      const esc = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      // 首尾都要锚定：QX 的正则是**部分匹配**，少了 ^ 会误伤把该 URL 当参数的请求。
      return convertRewrite(`^${esc}$ ${thenPart}`, plugin);
    }
    return skip(plugin, "Rewrite", line, "条件重写使用了 QX 无法表达的条件（@ 取反 / 组合）"), null;
  }
  if (!rawPat.startsWith("/") || !rawPat.endsWith("/")) {
    return skip(plugin, "Rewrite", line, "条件重写的 URL 匹配式不是正则"), null;
  }
  const re = rawPat.slice(1, -1);
  if (/\|\||&&|\s@\s/.test(re)) {
    return skip(plugin, "Rewrite", line, "条件重写包含组合/取反条件（QX 无等价语法）"), null;
  }
  return convertRewrite(`${re} ${thenPart}`, plugin);
}

/** 转换 [Rewrite] 的一行。Loon = `<regex> <action> [args]`，QX = `<regex> url <action> [args]`。 */
async function convertRewrite(line, plugin) {
  const m = line.match(/^(\S+)\s+(\S+)\s*(.*)$/);
  if (!m) return null;
  const [, pattern, action, rest] = m;
  const a = action.toLowerCase();

  const rej = REWRITE_ACTION[action.toUpperCase()];
  if (rej) return `${pattern} url ${rej}`;

  // jq-path / jq_file：Loon 外链 .jq 文件。QX 不会去取这个文件。
  // 由调用方（tryInlineJq）负责抓回并内联；这里只做标记。
  if (/jq[-_]path\s*=|jq_file\s*=/i.test(rest)) return { needsJqInline: true, pattern, raw: line };

  if (a === "response-body-json-del") {
    const paths = rest.trim().split(/\s+/).filter(Boolean);
    if (!paths.length) return skip(plugin, "Rewrite", line, "response-body-json-del 无路径参数"), null;
    // 短表达式用 QX 原生的 jsonjq（无脚本依赖、更快）；
    // 超长的改用一条 script-response-body —— 见 jsonDelScriptSource 的说明。
    if (paths.length > JQ_PATHS_PER_RULE) {
      notes.push({
        plugin, kind: "超长 jq 表达式改用脚本",
        detail: `${pattern.slice(0, 60)} —— ${paths.length} 个路径的 del(...) 超出 QX 单行上限，`
          + `改用一条 script-response-body（脚本里按段删除；不拆多条同 URL 规则，`
          + `因为同 URL 多条 body 重写的执行顺序不可预期）`,
      });
      return materializeScript(pattern, jsonDelScriptSource(paths));
    }
    return `${pattern} url jsonjq-response-body ${jsonDelToJq(paths)}`;
  }
  if (a === "response-body-json-replace") {
    const toks = rest.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2 || toks.length % 2 !== 0) {
      return skip(plugin, "Rewrite", line, "response-body-json-replace 参数不成对"), null;
    }
    const sets = [];
    // 路径必须走 jqPath()：`foo-bar` 之类的段不加引号会被 jq 当减法解析
    // （同类 bug 的另一个出口 —— 夸克那条就是 `result.quark-countdown-2025` 踩的）。
    for (let i = 0; i < toks.length; i += 2) sets.push(`${jqPath(toks[i])} = ${toks[i + 1]}`);
    return `${pattern} url jsonjq-response-body '${sets.join(" | ")}'`;
  }
  if (a === "response-body-json-jq" || a === "request-body-json-jq") {
    const expr = rest.trim();
    if (!expr || expr === "''" || expr === '""') {
      // 源插件里写的是 `response-body-json-jq ''`（空表达式）—— 在 Loon 里无副作用，
      // 但 QX 会拿到 `jsonjq-response-body ''`，是**非法 jq 表达式**（解析失败）。
      // 语义上「什么都不做」在 QX 无法表达，且同 URL 另有规整规则 → 丢弃并记账。
      return skip(plugin, "Rewrite", line, "json-jq 表达式为空（QX 无法表达空表达式，丢弃）"), null;
    }
    return `${pattern} url ${a.startsWith("response") ? "jsonjq-response-body" : "jsonjq-request-body"} ${expr}`;
  }
  if (a === "response-body" || a === "request-body") {
    if (!/\sresponse-body\s+/.test(rest)) {
      return skip(plugin, "Rewrite", line, `${a} 需要成对的 search/replace`), null;
    }
    return `${pattern} url ${a} ${rest}`;
  }
  if (a === "302" || a === "307") return `${pattern} url ${a} ${rest.trim()}`;

  // `reject_dict(200)` / `reject_dict()`：Loon 函数式写法 -> QX 的 `reject-dict`
  // （QX 的 reject-dict 固定返回 200 + `{}`，与 Loon 的 reject_dict(200) 等价；
  //  传入非 200 的状态码时 QX 无对应，退回 reject-200。）
  const fnRej = line.match(/^(\S+)\s+(reject[-_](?:dict|array|img|200|drop)?)\s*\((\d*)\)\s*$/i);
  if (fnRej) {
    const [, fpat, fname, code] = fnRej;
    const key = fname.toLowerCase().replace(/_/g, "-");
    const mapped = REWRITE_ACTION[key.toUpperCase()] ?? REWRITE_ACTION[key.replace(/-/g, "_").toUpperCase()];
    if (mapped) {
      if (code && code !== "200" && mapped === "reject-dict") return `${fpat} url reject-200`;
      return `${fpat} url ${mapped}`;
    }
    return skip(plugin, "Rewrite", line, `未识别的函数式拒绝动作（${fname}）`), null;
  }

  // ---------- Loon 的 `response.json.*` / `response.body.mock` 动作名 ----------
  // 这几种写法在 Loon 里把 jq 表达式/伪造体**直接内联在动作名里**（带括号和反引号），
  // 所以上面的 `^(\S+)\s+(\S+)\s*(.*)$` 切出来的 action 是残缺的 —— 必须先用整行匹配。
  const dotted = line.match(/^(\S+)\s+(response|request)\.(json\.jq_file|json\.jq|json\.delete|body\.mock|header\.set)\s*\(([\s\S]*)\)\s*$/);
  if (dotted) {
    const [, dpat, dir, kind, rawArgs] = dotted;
    const isResp = dir === "response";
    const stripQ = (s) => s.trim().replace(/^["'`]|["'`]$/g, "");
    if (kind === "json.jq") {
      const expr = rawArgs.trim().replace(/^`|`$/g, "");
      if (!expr) return skip(plugin, "Rewrite", line, "json.jq 无表达式"), null;
      return `${dpat} url ${isResp ? "jsonjq-response-body" : "jsonjq-request-body"} '${expr.replace(/'/g, "'\\''")}'`;
    }
    if (kind === "json.delete") {
      const paths = rawArgs.split(",").map(stripQ).filter(Boolean);
      if (!paths.length) return skip(plugin, "Rewrite", line, "json.delete 无路径"), null;
      return `${dpat} url jsonjq-response-body ${jsonDelToJq(paths)}`;
    }
    if (kind === "json.jq_file") {
      // 与 `jq-path=` 同源：外链 .jq 必须抓回内联（QX 不会去取这个文件）。
      const url = stripQ(rawArgs);
      const inlined = await inlineJqFile(url, plugin, line);
      if (!inlined) return null;
      return `${dpat} url jsonjq-response-body '${inlined}'`;
    }
    if (kind === "body.mock") {
      // `response.body.mock("json", `…`, 200)` / `response.body.mock("text", "<base64>", 200, true)`
      // 第 4 个位置参数是 **base64 标志**（与 mock-response-body 的 mock-data-is-base64 同义），
      // 忽略它会把 base64 字符串原样当 body 返回 —— 字节全错。
      // Loon 的 `then` 体可以用 ` | ` 串联多个动作（`body.mock(...) | response.header.set(...)`）。
      // 括号里只取**第一个动作**的参数 —— 不截断的话第 4 个参数会串进下一个动作
      // （实测 `parts[3]` 变成 `true) | response.header.set("grpc-status"`，base64 标志被漏判）。
      const firstAction = rawArgs.split(/\s*\|\s*/)[0];
      const parts = splitArgs(firstAction);
      const kindName = stripQ(parts[0] ?? "text").toLowerCase();
      const payload = (parts[1] ?? "").trim().replace(/^`|`$/g, "").replace(/^"|"$/g, "");
      if (!payload) return skip(plugin, "Rewrite", line, "body.mock 无 payload"), null;
      const isB64 = /^(?:true|1)$/i.test(stripQ(parts[3] ?? ""));
      if (isB64) {
        const bytes = Buffer.from(payload, "base64");
        return { needsEchoScript: true, pattern: dpat, source: echoScriptSource([...bytes].join(","), true) };
      }
      return { needsEchoScript: true, pattern: dpat, source: echoScriptSource(JSON.stringify(payload), false) };
    }
    if (kind === "header.set") {
      // QX 没有「直接改响应头」的行内动作，但 `script-response-header` 可以做 —— 需脚本。
      return skip(plugin, "Rewrite", line, "response.header.set 需要 script-response-header 小脚本（QX 无行内等价动作）"), null;
    }
  }

  // ---------- 以下四类原先被记成「QX 无对应动作名」，实际都有等价物 ----------

  // `header <url>`：**语义未证实**。两种证据互相冲突：
  //   ① KOP-XIAO resource-parser.js 的 `subs[i].split(" ")[2] == "header"` 分支
  //      把它归入重定向类、产出 `url 302 <url>`（本转换器原先照此实现）。
  //   ② Script-Hub 的 Rewrite-Parser 把它归入 rw_redirect 但**不转 302** ——
  //      对 Stash 映射成 `transparent`，对 Loon 原样保留 `header`，
  //      说明它是独立动作，语义与 302（响应重定向，客户端会看到新 URL）不同。
  // 无设备验证前不猜：按源插件的本意（改请求头/重定向）**保守放弃并如实记账**，
  // 而不是写一条语义可能不对的 302。要恢复就取消下面这行 skip、改用 302。
  if (a === "header") {
    skip(plugin, "Rewrite", line,
      "header 动作语义待核实（resource-parser 归为 302/307，Script-Hub 不转 302 而是保留为独立动作）" +
      "—— 未设备验证前不猜迁移，原样放弃");
    return null;
  }

  // `response-body-replace-regex <search> <replace>` -> QX 原生 `url response-body <search> response-body <replace>`。
  if (a === "response-body-replace-regex") {
    const { search, replace } = splitTwoFields(rest);
    if (!search || !replace) {
      return skip(plugin, "Rewrite", line, "response-body-replace-regex 需要成对的 search/replace"), null;
    }
    return `${pattern} url response-body ${search} response-body ${replace}`;
  }

  // `mock-response-body data-type=… data="…"`：直接返回伪造 body（不请求上游）。
  // QX 无同名动作，但两种等价写法：
  //   ① 纯文本/JSON 常量 -> `echo-response <mime> echo-response <data: 或 http(s) 文件 URL>`
  //      （QX 的 echo-response 的第三段可以是 `data:` URI，也可以是本仓库镜像过的文件 URL）
  //   ② base64（gRPC protobuf 等二进制）-> `echo-response application/octet-stream echo-response data:application/octet-stream;base64,<b64>`
  if (a === "mock-response-body" || a === "mock-response") {
    const m2 = rest.match(/data-type\s*=\s*(\S+?)(?:,|\s|$)/i);
    const m3 = rest.match(/data\s*=\s*"([\s\S]*)"\s*(?:mock-data-is-base64|status-code|$)/i);
    if (!m3) return skip(plugin, "Rewrite", line, "mock-response-body 取不到 data"), null;
    const kind = (m2 ? m2[1] : "text").toLowerCase();
    const data = m3[1];
    const isB64 = /mock-data-is-base64\s*=\s*true/i.test(rest);
    if (isB64) {
      // base64（gRPC protobuf 等二进制）-> 解码成字节字面量，走 bodyBytes。
      const bytes = Buffer.from(data, "base64");
      return { needsEchoScript: true, pattern, source: echoScriptSource([...bytes].join(","), true) };
    }
    // 数据以 JSON 字符串字面量嵌进脚本（QX 脚本里 body 是字符串）。
    return { needsEchoScript: true, pattern, source: echoScriptSource(JSON.stringify(data), false) };
  }

  // ---------- Loon 的脚本化写法 `request|response if ${url} ~= /re/ then <动作>` ----------
  // QX 没有 if 语法，但**条件本身就是一个 URL 正则** —— 直接取出来当 pattern，
  // 再把 then 后面的动作按普通动作转换即可（等价改写，不是丢弃）。
  const cond = line.match(/^(?:request|response)\s+if\s+\$\{url\}\s*(~=|==)\s*(\/.*\/|".*")\s+then\s+(.+)$/);
  if (cond) {
    const [, op, rawPat, thenPart] = cond;
    const inner = await convertIfThen(rawPat, op, thenPart.trim(), plugin, line);
    return inner;
  }

  // 注意措辞：这里是**转换器没实现**，不等于 QX 做不到。已核实的等价物：
  //   mock-response-body            -> script-echo-response / echo-response（返回固定 body）
  //   response-body-replace-regex   -> `url response-body <正则> response-body <替换>`
  //   header（重写请求 URL）          -> `url 302 <新URL>` / `url 307 <新URL>`
  // 写错措辞会把「没实现」传播成「做不到」，下次维护就不会去补了。
  skip(plugin, "Rewrite", line, `转换器未实现该动作（${action}）；QX 侧需 script-response-header 小脚本，见 TODO.md`);
  return null;
}

/** 解析 [Argument] 段，得到每个参数的**默认值**（Loon 插件参数面板的初值）。 */
function parseArgumentDefaults(text) {
  const out = new Map();
  for (const raw of sectionLines(text, "Argument") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const m = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!m) continue;
    const [, key, rest] = m;
    // 形式：`select,"默认","其它",tag=…` / `switch,true,tag=…` / `input,"",tag=…`
    const typeM = rest.match(/^(select|switch|input|textarea)\s*,\s*/i);
    if (!typeM) continue;
    const after = rest.slice(typeM[0].length);
    const firstVal = after.match(/^("([^"]*)"|'([^']*)'|true|false|[^,]*)/);
    if (!firstVal) continue;
    let v = firstVal[0].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1);
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    out.set(key, v);
  }
  return out;
}

/**
 * QX 没有 Loon/Surge 的插件参数体系，但脚本读的是 `$argument` 的 JSON 字符串。
 * QX 会把脚本 URL 的 `#` 片段放进 `$environment.params`，所以在镜像脚本头部
 * 注入一段 **安全的** 桥接：只有在 `$argument` 未定义且 `$environment.params` 存在时才生效。
 * 若 QX 不提供 params，这段是 no-op —— 脚本行为与不加时完全一致，不会弄坏现状。
 */

/** 从 `argument=[{a},{b}]` 取参数名。 */
function argKeysOf(optsRaw) {
  const m = optsRaw.match(/(?:^|,)\s*argument=\[([^\]]*)\]/);
  if (!m) return null;
  return m[1]
    .split(",")
    .map((x) => x.trim().replace(/^\{|\}$/g, "").trim())
    .filter(Boolean);
}

/** 转换 [Script] 的一行。 */
function convertScript(line, plugin, argDefaults) {
  let m = line.match(/^(http-request|http-response)\s+(\S+)\s+(.*)$/);
  if (!m) {
    // Loon 的 `request|response if ${url} ~= /re/ then script("...") with k=v, ...`
    // 条件就是 URL 正则（QX 每行重写天然只对匹配该正则的 URL 生效），
    // `then script("...")` 的 `with k=v` 选项与 [Script] 段的 `script-path=..., k=v` 同构 ——
    // 归一成 http-request/http-response 形式后走完全相同的下游逻辑。
    const c = line.match(/^(request|response)\s+if\s+\$\{url\}\s*(~=|==)\s*(\/.*\/)".*"?\s+then\s+script\s*\(\s*"([^"]+)"\s*(?:,[^)]*)?\)\s*(?:with\s+)?(.*)$/)
      ?? line.match(/^(request|response)\s+if\s+\$\{url\}\s*(~=|==)\s*(\/.*\/)\s+then\s+script\s*\(\s*"([^"]+)"\s*(?:,[^)]*)?\)\s*(?:with\s+)?(.*)$/);
    if (c) {
      const [, dir, op, rawPat, scriptUrl, opts] = c;
      if (op === "~=" && rawPat.startsWith("/") && rawPat.endsWith("/")) {
        m = [null, dir === "request" ? "http-request" : "http-response", rawPat.slice(1, -1), `script-path=${scriptUrl}${opts ? ", " + opts : ""}`];
      }
    }
  }
  if (!m) {
    // `generic script-path=...`（Loon 菜单手动触发脚本）：QX 的**挂载点是有的** ——
    // [task_local] 的 `event-interaction`（官方 sample.conf 确认）。
    // 但这里不自动产出：这些脚本依赖 Loon 的节点上下文
    // （`$environment.params.node` / `nodeInfo`，见 LocationDetection.js:13/58），
    // QX 下拿不到，迁过来只是个点了就报错的入口。
    // 该插件功能已由 sources.json 的 tasks「节点详情查询」替代（`replaces` 字段声明）。
    if (/^generic\s/.test(line)) {
      const sp = line.match(/script-path=(\S+?)(?:,|$)/);
      skip(plugin, "Script", line,
        "菜单触发脚本：QX 有 event-interaction 挂载点，但脚本依赖 Loon 的节点上下文" +
        "（$environment.params.node / nodeInfo），QX 下拿不到；功能已由 tasks「节点详情查询」替代" +
        (sp ? ` —— ${stripQuotes(sp[1]).split("/").pop()}` : ""));
      return null;
    }
    skip(plugin, "Script", line, "既不是 request/response 脚本，也不是可迁移的 generic 脚本");
    return null;
  }
  const [, trigger, pattern, optsRaw] = m;
  const sp = optsRaw.match(/script-path=(\S+?)(?:,|$)/);
  if (!sp) return skip(plugin, "Script", line, "没有 script-path="), null;
  const scriptUrl = stripQuotes(sp[1]);

  // `argument=` / `enable=` 是 Loon 的插件参数体系，QX 没有等价物。
  // 处理方式：把 Loon [Argument] 段的**默认值**内联成 URL `#` 片段，并在镜像脚本
  // 头部注入桥接（见 ARG_SHIM），使脚本读到与源插件相同的默认参数。
  // QX **没有**插件参数机制：`$argument` 在 QX 下不存在，
  // 而 `$environment.params` 是**节点信息**（见 LocationDetection.js 的注释：
  // `$environment.params.node` / `nodeInfo`），不是脚本 URL 的 # 片段。
  // 所以「把参数塞进 # 片段 + 桥接成 $argument」是错的 —— 注入节点信息可能让
  // 脚本走进非预期分支（脚本常把 `$argument !== undefined` 当"用户配置过"的开关）。
  // 如实记账为「未复刻」，不做看起来做了实则没生效的补丁。
  const argKeys = argKeysOf(optsRaw);
  if (argKeys) {
    const kv = argDefaults ? argKeys.filter((k) => argDefaults.has(k)).map((k) => `${k}=${argDefaults.get(k)}`) : [];
    notes.push({
      plugin,
      kind: "插件参数未复刻",
      detail: `argument=[${argKeys.join(",")}]${kv.length ? "（[Argument] 默认值: " + kv.join(", ") + "）" : ""} —— QX 无插件参数机制，脚本将走自身默认分支`,
    });
  } else if (/(?:^|,)\s*argument=\[/.test(optsRaw) === false && /(?:^|,)\s*argument=/.test(optsRaw)) {
    // 形如 argument="search->replace"（CommonScript/replace-body.js 的替换参数），
    // 不是插件参数键值对，QX 无法表达
    const a = optsRaw.match(/(?:^|,)\s*argument=("[^"]*"|[^,]*)/);
    notes.push({ plugin, kind: "非键值型 argument 无法内联", detail: `${(a?.[1] ?? "").slice(0, 80)}` });
  }
  if (/enable\s*=\s*\{/.test(optsRaw)) {
    notes.push({ plugin, kind: "条件启用无法表达", detail: "enable={...} —— 该规则在源插件里可按参数关闭，QX 只能无条件生效" });
  }
  // binary-body-mode：protobuf 响应体。QX 对二进制体的处理与 Loon 不同，
  // 这类脚本能否正常工作未经设备验证。
  if (/binary-body-mode\s*=\s*(1|true)/i.test(optsRaw)) {
    notes.push({ plugin, kind: "二进制体脚本（未验证）", detail: `${pattern.slice(0, 60)} —— binary-body-mode 脚本，QX 侧可否解包 protobuf 未经设备验证` });
  }

  const action = trigger === "http-request" ? "script-request-body" : "script-response-body";
  return { line: `${pattern} url ${action} ${scriptUrl}` };
}

// ---------------------------------------------------------------- 分流

/**
 * 转换 [Rule] 的一行。
 * 返回 {kind:"filter"|"rewrite", line} 或 null（已记账）。
 * URL-REGEX 分流在 QX 里没有对应**分流**类型，但有精确的重写等价物：`<re> url reject`。
 * 这些规则是 http:// 的（无需 MITM），搬到重写段即可完整复刻。
 */
function convertRule(line, plugin) {
  if (/^(AND|OR|NOT)\s*[,((]/i.test(line)) return convertAnd(line, plugin);

  const parts = line.split(",").map((x) => x.trim());
  const type = parts[0].toUpperCase();

  // URL-REGEX -> 重写 (reject 系列)
  if (type === "URL-REGEX") {
    const re = stripQuotes(parts[1] ?? "");
    const pol = (parts[parts.length - 1] ?? "").toUpperCase();
    const act = REWRITE_ACTION[pol];
    if (!re) return skip(plugin, "Rule", line, "URL-REGEX 无表达式"), null;
    if (!act) {
      return skip(plugin, "Rule", line, `URL-REGEX 的策略 ${pol} 无重写等价物（QX 重写只支持 reject 系列）`), null;
    }
    return { kind: "rewrite", line: `${re} url ${act}` };
  }
  if (type === "PROTOCOL" || type === "DEST-PORT") {
    return skip(plugin, "Rule", line, `QX 分流无此类型（${type}）`), null;
  }

  const qxType = RULE_MAP[type];
  if (!qxType) return skip(plugin, "Rule", line, `QX 分流词表无此类型（${type}）`), null;
  if (parts.length < 3) return skip(plugin, "Rule", line, "字段不足（缺策略）"), null;

  const value = type === "USER-AGENT" ? stripQuotes(parts[1]) : parts[1];
  // `IP-CIDR, x/32, REJECT, no-resolve` —— no-resolve 是策略之后的**修饰符**，
  // 不是策略。QX 没有它，丢掉即可（曾误判成策略位冲突，白丢 75 条有效规则）。
  const fields = parts.slice(2).filter((x) => !/^no-resolve$/i.test(x));
  const policy = (fields[fields.length - 1] ?? "").replace(/\s*\/\/.*$/, "").trim();
  if (!policy) return skip(plugin, "Rule", line, "剥离 no-resolve 后没有策略了"), null;
  return { kind: "filter", line: `${qxType}, ${value}, ${FILTER_POLICY[policy.toUpperCase()] ?? policy}` };
}

/**
 * AND/OR/NOT 组合规则。
 * QX 分流不支持逻辑组合，但 `URL-REGEX + USER-AGENT` 这个组合在 QX **重写**里有精确对应：
 *   `<re> \r\nUser-Agent: <ua> url-and-header <action>`
 * （官方 sample.conf：`;^http://example.com/resource1/1/ \r\nUser-Agent: example-agent url-and-header reject`）
 */

/**
 * 从 AND(...) 里按**括号深度**切出顶层条件项。
 * 不能用 `\(([^()]+?)\)` —— PDD 的 URL-REGEX 本身含嵌套括号
 * （`^http:\/\/((25[0-5]|...)...)`），正则会在第一个 `)` 处截断，导致条件项解析不出来。
 */
function topLevelItems(s) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(s.slice(start, i));
        start = -1;
      }
    }
  }
  return out;
}

/** 解析单个条件项 `TYPE, value` -> {type, value}；嵌套 OR 项返回 null。 */
function parseAtom(item) {
  const m = item.match(/^\s*([A-Z-]+)\s*,\s*([\s\S]*)$/);
  if (!m) return null;
  const type = m[1].toUpperCase();
  if (type === "OR" || type === "AND" || type === "NOT") return null;
  return { type, value: stripQuotes(m[2]) };
}

function convertAnd(line, plugin) {
  const polM = line.match(/\),\s*([A-Za-z-]+)\s*$/);
  const pol = (polM?.[1] ?? "").toUpperCase();

  const head = line.match(/^\s*(AND|OR|NOT)\s*,\s*\(([\s\S]*)\)\s*,\s*[A-Za-z-]+\s*$/);
  const atoms = head ? topLevelItems(head[2]).map(parseAtom).filter(Boolean) : [];

  // QUIC 类：QX 没有 PROTOCOL 条件，但 udp_drop_list=443 已全局覆盖
  if (/PROTOCOL\s*,\s*QUIC/i.test(line)) {
    skip(plugin, "Rule", line, "AND(...PROTOCOL QUIC) —— QX 无 PROTOCOL 条件；已由 [general] 的 udp_drop_list=443 覆盖");
    return null;
  }
  const urlRe = atoms.filter((a) => a.type === "URL-REGEX");
  const ua = atoms.filter((a) => a.type === "USER-AGENT");
  const isAnd = /^\s*AND\b/i.test(line);
  if (isAnd && urlRe.length === 1 && ua.length === 1 && atoms.length === 2) {
    const act = REWRITE_ACTION[pol];
    if (!act) {
      skip(plugin, "Rule", line, `AND(URL-REGEX, USER-AGENT) 的策略 ${pol} 无重写等价物（QX 重写只支持 reject 系列）`);
      return null;
    }
    // QX 的 url-and-header 写法：`<re> \r\nUser-Agent: <ua> url-and-header <action>`
    return { kind: "rewrite", line: `${urlRe[0].value} \\r\\nUser-Agent: ${ua[0].value} url-and-header ${act}` };
  }
  skip(plugin, "Rule", line, "AND/OR/NOT 组合规则 —— QX 分流不支持逻辑组合，且无重写等价物");
  return null;
}

// ---------------------------------------------------------------- 资产

function mirrorPathFor(url) {
  const m = url.match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const u = new URL(url);
  return `snapshot/host/${u.hostname}${u.pathname}`;
}

/** 取资产内容：优先用 vendor 里的离线副本，其次带 Loon UA 抓取。失败返回 null。 */
async function fetchAsset(url) {
  const base = url.split("/").pop().split("?")[0];
  const offline = join(VENDOR, "_assets", base);
  if (existsSync(offline)) {
    const b = readFileSync(offline);
    if (b.length > 100) return b;
  }
  try {
    const res = await fetch(url, { headers: UA, redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 100 ? buf : null;
  } catch {
    return null;
  }
}

/** 把 mock 生成的脚本落盘到 QuantumultX/rules/rewrite/kelee/mock/，返回 script-echo-response 行。 */
async function materializeEchoScript({ pattern, source }, plugin) {
  // 确定性命名（内容哈希，无时间戳）：同名即同内容，CI 重跑不会产生无意义 diff。
  // **不经过 mirrorAsset** —— 那个函数是给"远程 URL"用的（mirrorPathFor 要 new URL()），
  // 且它「已存在且 size>100 就跳过」，而这里生成的脚本可能只有几十字节，会被反复重抓。
  const hash = createHash("sha1").update(pattern + "\u0000" + source).digest("hex").slice(0, 12);
  const rel = `QuantumultX/rules/rewrite/kelee/mock/${hash}.js`;
  const abs = join(ROOT, rel);
  if (!CHECK) {
    mkdirSync(dirname(abs), { recursive: true });
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== source) writeFileSync(abs, source);
  }
  usedMocks.add(rel);
  return `${pattern} url script-echo-response ${repoBase}/${rel}`;
}

/** 把脚本/资产镜像进仓库，返回仓库内相对路径；失败返回 null。 */
async function mirrorAsset(url) {
  // **本仓库自己的**地址：文件已经在磁盘上（materializeEchoScript 刚落盘），
  // 不需要也不应该去网上抓 —— CI 里此时还没推送，抓必然失败，
  // 结果是刚生成的规则被自己判成「镜像失败」丢掉。
  if (url.startsWith(`${repoBase}/`)) {
    const rel = decodeURIComponent(url.slice(repoBase.length + 1)).split("#")[0];
    return existsSync(join(ROOT, rel)) ? rel : null;
  }
  const rel = mirrorPathFor(url);
  const abs = join(ROOT, rel);
  if (existsSync(abs) && statSync(abs).size > 100) return rel;
  const body = await fetchAsset(url);
  if (!body) return null;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return rel;
}

/**
 * 内联 Loon 的外链 .jq 文件。
 * 这些 .jq 常是多行且含 `#` 注释 —— 直接塞进单行 rewrite 会把行拆断（QX 会解析失败），
 * 所以先剥注释、把多行折叠成单行，再包在单引号里。折叠不了的就记账跳过。
 */
async function tryInlineJq(pattern, line, plugin) {
  const m = line.match(/jq[-_]path\s*=\s*"([^"]+)"/i) || line.match(/jq[-_]path\s*=\s*([^\s,]+)/i);
  if (!m) return skip(plugin, "Rewrite", line, "jq-path 但取不到文件地址"), null;
  const url = m[1];
  const buf = await fetchAsset(url);
  if (!buf) return skip(plugin, "Rewrite", line, `jq-path 文件取不到（${url}）`), null;
  const inline = buf
    .toString("utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s*#.*$/, "").trim()) // 去注释（QX 的 jq 在单行里，注释会截断表达式）
    .filter(Boolean)
    .join(" ")
    .replace(/'/g, "'\\''");
  if (!inline) return skip(plugin, "Rewrite", line, "jq-path 文件折叠后为空"), null;
  return `${pattern} url jsonjq-response-body '${inline}'`;
}

// ---------------------------------------------------------------- 主流程

const index = JSON.parse(readFileSync(join(VENDOR, "index.json"), "utf8"));
mkdirSync(OUT_REWRITE, { recursive: true });
mkdirSync(OUT_FILTER, { recursive: true });

const seeded = [];           // 参与比对的既有源（仅用于报告）
// 「会改写响应体」的动作 —— 重复了才有真风险（reject 族重复是幂等的）。
// echo-response 也必须算进来：两个插件对同一 URL 返回不同伪造 body 是真冲突
// （本轮实例：kokoryh bilibili.lpx 与 kelee Bilibili_remove_ads.lpx 各自拦 B 站同一批接口）。
const isBodyRewrite = (l) => /\surl\s+(script-|jsonjq-|echo-response)/.test(l);
/** 重写动作分类：reject 族重复是幂等的（同策略同结果），body 改写重复才有真风险。 */
const REJECT_ACTIONS = new Set(["reject", "reject-dict", "reject-200", "reject-array", "reject-img", "reject-drop"]);
const actionOf = (line) => (line.match(/\surl(?:-and-header)?\s+(\S+)/) ?? [])[1]?.toLowerCase() ?? "";
const isRejectAction = (line) => REJECT_ACTIONS.has(actionOf(line));

function snapshotPathFor(url) {
  const m = (url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const m2 = (url ?? "").match(/^https:\/\/([^/]+)\/(.+)$/);
  return m2 ? `snapshot/host/${m2[1]}/${m2[2]}` : null;
}

// 去重已移交 tools/vendor-rules.mjs 的合并步骤（kelee 排第一个来源 = kelee 胜出），
// 所以这里不再收集其他源的规则、也不生成排除清单。
const written = new Set();
const allHostnames = new Set();
let deduped = 0;

/**
 * 产物合并：同一 App 被拆成多个上游插件时（实为同一作者的不同版本，
 * 如 kokoryh 自建 `bilibili.lpx` 与 kelee 托管的 `Bilibili_remove_ads.lpx`），
 * 在**转换期**合并成一份产物 —— 而不是让两份规则在 [rewrite_remote] 里重复处理同一响应体。
 *
 * 胜出者由 MERGE_GROUPS 的 `plugins[0]` **显式声明**，不看 Loon 的插件列表顺序：
 * 那个顺序只代表「Loon 里谁先生效」，而用户的偏好可能与之不同。
 * 胜出者的规则先占据判重池；同组后续插件里与之重复的被丢弃并记账。
 * 注意只在**跨插件**判重；同一插件内同 URL 的多条规则是链式互补，全部保留。
 */
const usedMocks = new Set();   // 本轮真正被引用的 mock 脚本（用于清理孤儿）
const mergedFilters = new Map();   // 产物名 -> { header, lines }（被合并插件的分流累加到这里）
const mergedFilterSigs = new Map(); // 产物名 -> Set<归一化分流行>
const mergedRewrites = new Map();  // 产物名 -> { header, lines, hosts }
const mergePools = new Map();      // 产物名 -> 已产出规则（语义签名）
const mergePatPools = new Map();  // 产物名 -> 已产出 URL 正则
const mergeExactPools = new Map();// 产物名 -> 已产出整行
/**
 * 合并组：同一 App 被拆成多个上游插件时，合并成一份产物。
 *
 * `plugins` 的**第一个是胜出者**（它的规则优先占据判重池，后面的插件与之重复的规则被丢弃）。
 * 注意这里显式声明胜出者，而不是靠 index.plugins 的遍历顺序 —— Loon 的插件列表顺序
 * （kokoryh 第 6、kelee 第 31）只代表"Loon 里谁先生效"，用户的偏好可以与之不同。
 * 用户 2026-09-27 明确：**B 站用 kelee 版胜出**（kelee 的实现更新、覆盖面更广）。
 */
const MERGE_GROUPS = [
  { name: "bilibili", plugins: ["Bilibili_remove_ads.lpx", "bilibili.lpx"] },
];
const mergeTargetOf = new Map();   // 插件名 -> 产物名
const mergeWinnerOf = new Map();   // 产物名 -> 胜出插件名
for (const g of MERGE_GROUPS) {
  g.plugins.forEach((n, i) => {
    mergeTargetOf.set(n, g.name.replace(/\.lpx$/, ""));
    if (i === 0) mergeWinnerOf.set(g.name.replace(/\.lpx$/, ""), n);
  });
}

// 按「合并组内胜出者优先」重排遍历顺序（组内成员插在首个成员原本的位置）
const pluginOrder = [];
const seenInGroup = new Set();
for (const p of index.plugins) {
  const g = MERGE_GROUPS.find((x) => x.plugins.includes(p.name));
  if (!g) { pluginOrder.push(p); continue; }
  if (seenInGroup.has(g.name)) continue;
  seenInGroup.add(g.name);
  for (const nm of g.plugins) {
    const m = index.plugins.find((x) => x.name === nm);
    if (m) pluginOrder.push(m);
  }
}

for (const p of pluginOrder) {
  if (!p.file) continue;
  const text = readFileSync(join(ROOT, p.file), "utf8");
  const nm = text.match(/^#!name\s*=\s*(.+)$/m)?.[1]?.trim() || p.name.replace(/\.lpx$/, "");
  if (!p.enabled || SKIP_PLUGINS.has(p.name)) {
    pluginReport.push({
      plugin: p.name, name: nm, enabled: false, rules: 0, rewrites: 0, hostnames: 0,
      skipped_reason: SKIP_PLUGINS.has(p.name) ? "用户从配置中去掉" : "源配置里 enabled=false",
    });
    continue; // 不产出文件，避免"已生成但无人引用"的孤儿
  }
  const base = p.name.replace(/\.lpx$/, "");
  // 该插件的规则最终写进哪个产物（被合并时写进「前者」的产物）
  const targetBase = mergeTargetOf.get(p.name) ?? base;
  const selfRel = `QuantumultX/rules/rewrite/kelee/${targetBase}.snippet`;

  const argDefaults = parseArgumentDefaults(text);
  const filters = [];
  const rewrites = [];

  // 合并同一插件内「同 URL 的多条 jsonjq 表达式」为一条。
  //
  // ⚠ 这是 QX 与 Loon 的**行为差异**，不是去重：Loon 对同 URL 的多条 body 重写是
  // **链式叠加**（作者刻意分开写），QL 只执行**先匹配的第一条** —— 后面的静默不生效。
  // 实测：拼多多的 `api.pinduoduo.com/api/alexa/homepage/hub?` 有两条
  // （`del(banner...)` 与 `bottom_tabs 过滤`），QX 只跑第一条 → 「去除底部按钮」永远不生效。
  // 全仓库共 13 对受影响（拼多多/闲鱼/知乎/爱奇艺/smzdm）。
  //
  // jq 的 `A | B` 就是顺序管道，语义上等价于「先跑 A 再跑 B」，
  // 所以直接串成一条表达式即可。
  const mergeSameUrlJq = (list) => {
    const groups = new Map();     // 完整行前缀(URL 正则 + 动作名) -> 表达式列表
    const order = [];
    for (const line of list) {
      const m = line.match(/^(.*?\surl\s+(jsonjq-response-body|jsonjq-request-body))\s+'([\s\S]*)'\s*$/);
      if (!m) { order.push({ raw: line }); continue; }
      const key = m[1];
      // 只有多条同 URL 的同名动作才需要合并；单条保持原样（避免无谓改写）
      if (!groups.has(key)) { groups.set(key, []); order.push({ key }); }
      groups.get(key).push(m[3]);
    }
    return order.map((o) => {
      if (o.raw !== undefined) return o.raw;
      const exprs = groups.get(o.key);
      const joined = exprs.join(" | ");
      // `IN(a,b,c)` -> `x == a or x == b or x == c`：QX 的 jsonjq 是受限实现，
      // 实测扫遍仓库里所有 QX 原生资源（31 条 jsonjq 规则）从未出现 `IN(`。
      return `${o.key} '${rewriteInToOr(joined)}'`;
    });
  };

  for (const raw of sectionLines(text, "Rule") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const res = convertRule(line, p.name);
    if (!res) continue;
    (res.kind === "filter" ? filters : rewrites).push(res.line);
  }

  for (const raw of sectionLines(text, "Rewrite") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    let r = await convertRewrite(line, p.name);
    if (r && typeof r === "object" && r.needsJqInline) r = await tryInlineJq(r.pattern, line, p.name);
    if (r && typeof r === "object" && r.needsEchoScript) {
      r = await materializeEchoScript(r, p.name);
    }
    // convertRewrite 可返回数组（超长 jq 表达式被拆成多条同 URL 规则）
    if (Array.isArray(r)) rewrites.push(...r);
    else if (r) rewrites.push(r);
  }
  for (const raw of sectionLines(text, "Script") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const r = convertScript(line, p.name, argDefaults);
    if (!r) continue;
    // Loon `generic` 菜单脚本 -> QX [task_local] 的 event-interaction
    rewrites.push(r.line);
  }

  // 先合并「同插件内同 URL 的多条 jsonjq」（QX 只跑第一条，必须串成一条）
  {
    const before = rewrites.length;
    const merged = mergeSameUrlJq(rewrites);
    rewrites.length = 0;
    rewrites.push(...merged);
    if (merged.length < before) {
      notes.push({
        plugin: p.name, kind: "同URL多条jq已串接",
        detail: `同一 URL 的多条 jsonjq 表达式在 QX 里**只执行第一条**（Loon 是链式叠加），`
          + `已用 jq 管道 ' | ' 串成一条：${before} -> ${merged.length} 行`,
      });
    }
  }

  // kelee 侧内部去重，与**其他源**的跨源去重已移交 tools/vendor-rules.mjs 的合并步骤
  // （kelee 排第一个来源 = kelee 胜出，合并时按语义判据跳过后续重复）。
  //
  // ⚠ 去重作用域必须限定为「**跨插件**」：同一插件内同 URL 的多条规则往往是**链式互补**
  // 的（Loon/QX 对同 URL 的多条 body 重写是顺序生效，作者刻意分开写）。实例：kelee 的
  // smzdm 插件对 `app-api.smzdm.com/util/update$` 写了 3 条（json-replace → json-del →
  // json-jq），全都必须保留。第一版把去重状态声明在插件循环之外、又用「同 URL 即重复」
  // 判据，于是插件内第 2、3 条被自己的第 1 条顶掉 —— 静默功能损失。
  const claimedLocalPat = new Set();          // 本插件内用：同 URL 只用于**报错提示**，不丢规则
  // 跨插件/跨源去重池：按**产物**持有（被 MERGE_GROUPS 合并的插件共享同一个池子，
  // 所以后一个插件里与前者重复的规则会在这里被丢掉）。
  const mergeKey = targetBase;
  const claimedCross = mergePools.get(mergeKey) ?? [];
  const claimedCrossPat = mergePatPools.get(mergeKey) ?? new Map();
  const claimedCrossExact = mergeExactPools.get(mergeKey) ?? new Map();
  mergePools.set(mergeKey, claimedCross);
  mergePatPools.set(mergeKey, claimedCrossPat);
  mergeExactPools.set(mergeKey, claimedCrossExact);
  const kept = [];
  for (const r of rewrites) {
    const pat = r.split(/\s+(?:url|url-and-header)\s+/)[0];
    if (!isBodyRewrite(r)) {
      kept.push(r);
      continue;
    }
    // 只在「会改写响应体」的动作上判重（reject 类重复幂等，可保留）。
    const sig = ruleSig(pat);
    if (claimedLocalPat.has(pat)) {
      // 同插件内同 URL 的补充规则：**保留**。Loon/QX 是同 URL 多条 body 重写顺序链式生效，
      // 作者刻意分开写（如 smzdm 的 replace → del → jq 三段）。
      notes.push({
        plugin: p.name, kind: "同插件同URL多条（链式保留）",
        detail: `${pat.slice(0, 70)} —— Loon/QX 对同 URL 的多条 body 重写按顺序叠加生效，全部保留`,
      });
      kept.push(r);
      continue;
    }
    claimedLocalPat.add(pat);

    // 跨插件：同一 URL 正则被两个插件产出、动作不同（如 kokoryh 与 kelee 都在拦 B 站
    // 同一批接口但返回不同 body）—— **真冲突**。Loon 按插件列表顺序先生效，这里同序。
    const samePat = claimedCrossPat.get(pat);
    // ⚠ 必须排除「本插件自己产出的行」：sameTarget 在**同域同前缀的长路径**上会集体失明 ——
    // 判据是「共同路径词元 ≥2」，而淘系接口的公共词（gw/mtop/taobao/idlehome）恒被算进来，
    // 于是同插件内两条**不同** URL 被误判为同一目标并互相顶掉。实测损失：kelee
    // FleaMarket_remove_ads 的 12 条闲鱼接口规则被它自己的第 1 条吃掉。
    // 排除自身后剩下的才是真「跨插件重复」。
    // 只与**别的插件**产出的行比语义。归属键必须是**插件名**：被 MERGE_GROUPS 合并的两个插件
    // 算出的 selfRel 相同（同一个产物），用产物路径排除会把整个池子排除掉，等于关闭跨插件去重。
    const sameSig = claimedCross.find((c) => c.plugin !== p.name && sameTarget(sig, c.sig));
    const sameExact = claimedCrossExact.get(r);
    if (samePat || sameSig || sameExact) {
      deduped++;
      const who = samePat ?? sameSig?.from ?? sameExact;
      skip(p.name, "Rewrite", r, `与另一个 kelee 插件产出重复（保留先出现的那个：${who}）`);
      continue;
    }
    claimedCross.push({ pat, sig, plugin: p.name, from: selfRel });
    claimedCrossPat.set(pat, selfRel);
    claimedCrossExact.set(r, selfRel);
    kept.push(r);
  }

  // 脚本必须镜像进仓库：kelee.one 对 QX 的 UA 返回 403，直链会静默失效。
  // 镜像失败 -> **整条丢弃并记账**（绝不能回退成上游 URL：那等于埋一条必然失效的规则）。
  const localized = [];
  for (const r of kept) {
    const m = r.match(/^(.*\surl(?:-and-header)?\s+script-\S+\s+)(https?:\/\/[^\s#]+)(#.*)?$/);
    if (!m) {
      localized.push(r);
      continue;
    }
    const [, prefix, url] = m;
    const rel = await mirrorAsset(url);
    if (!rel) {
      skip(p.name, "Rewrite", r, `脚本镜像失败、已丢弃（避免留下必然失效的直链）: ${url}`);
      continue;
    }
    localized.push(`${prefix}${repoBase}/${rel}`);
  }

  const hosts = [];
  for (const raw of sectionLines(text, "MitM") ?? []) {
    const line = cleanRule(raw);
    if (!line || !/^hostname\s*=/i.test(line)) continue;
    for (const h of line.split("=", 2)[1].split(",")) {
      const v = h.trim();
      if (v && /^[A-Za-z0-9*?._-]+$/.test(v) && !v.startsWith("-")) hosts.push(v);
    }
  }
  for (const h of hosts) allHostnames.add(h);

  const header = [
    `# ${nm}  —— 由 vendor/loon-plugins/${p.name} 自动转换（tools/convert-plugins.mjs）`,
    `# 源插件: ${p.url}`,
    "# 请勿手工编辑：改源插件后重新运行 bun tools/fetch-plugins.mjs && bun tools/convert-plugins.mjs",
  ];
  // 被合并组内的非胜出插件不单独产出文件：它的规则累加到「前者」的产物里。
  // 这样 [rewrite_remote]/[filter_remote] 里只有一份条目，同一响应体不会被处理两次。
  // 分流侧跨插件去重：同产物内 (type, value, policy) 完全相同的行只留一条。
  const fKey = (l) => l.trim().toLowerCase();
  const seenF = mergedFilterSigs.get(targetBase) ?? new Set();
  mergedFilterSigs.set(targetBase, seenF);
  const filtersDedup = [];
  for (const f of filters) {
    if (seenF.has(fKey(f))) continue;
    seenF.add(fKey(f));
    filtersDedup.push(f);
  }
  const slotF = mergedFilters.get(targetBase) ?? { header: null, lines: [] };
  const slotR = mergedRewrites.get(targetBase) ?? { header: null, lines: [], hosts: [] };
  slotF.lines.push(...filtersDedup);
  slotR.lines.push(...localized);
  slotR.hosts.push(...hosts);
  if (!slotF.header) slotF.header = header;
  if (!slotR.header) slotR.header = header;
  mergedFilters.set(targetBase, slotF);
  mergedRewrites.set(targetBase, slotR);
  if (mergeTargetOf.has(p.name)) {
    pluginReport.push({
      plugin: p.name, name: nm, enabled: true, rules: filters.length, rewrites: localized.length,
      hostnames: hosts.length, merged_into: `${targetBase}.snippet`,
      merge_role: mergeWinnerOf.get(targetBase) === p.name ? "胜出者（规则优先）" : "被合并（重复的已丢弃并记账）",
    });
    continue;   // 不单独写文件
  }
  pluginReport.push({ plugin: p.name, name: nm, enabled: true, rules: filters.length, rewrites: localized.length, hostnames: hosts.length });
}

// 统一写出（含被合并插件的累加内容）—— 每个产物只出现一次。
for (const [b, slot] of mergedFilters) {
  if (!slot.lines.length) continue;
  writeIfChanged(join(OUT_FILTER, `${b}.list`), [...slot.header, "", ...slot.lines, ""].join("\n"));
  written.add(`${b}.list`);
}
for (const [b, slot] of mergedRewrites) {
  if (!slot.lines.length) continue;
  const uniqHosts = [...new Set(slot.hosts)];
  writeIfChanged(
    join(OUT_REWRITE, `${b}.snippet`),
    [...slot.header, "", ...slot.lines, "", `hostname = ${uniqHosts.join(", ")}`, ""].join("\n"),
  );
  written.add(`${b}.snippet`);
}

// ---- 去重职责已移交 tools/vendor-rules.mjs 的合并步骤 ----
// 合并按 (正则,动作) + 语义判据在**源之间**去重，且 kelee 排第一个来源 = kelee 胜出。
// 所以这里不再生成 _exclusions.json（原机制要求目标资源仍是 rewrite_remote 条目，
// 而合并后它们已不是，清单永远落不了地）。

// ---- 清理本轮不再产出的文件（禁用/改名/删除插件都不会留下孤儿） ----
const pruned = [];
if (!CHECK) {
  // mock 脚本也要清孤儿：materializeEchoScript 在去重**之前**落盘，
  // 被去重丢掉的规则会留下无人引用的脚本（实测残留 3 个）。
  const mockDir = join(OUT_REWRITE, "mock");
  if (existsSync(mockDir)) {
    for (const f of readdirSync(mockDir)) {
      if (!/\.js$/.test(f)) continue;
      const rel = `QuantumultX/rules/rewrite/kelee/mock/${f}`;
      if (!usedMocks.has(rel)) { rmSync(join(mockDir, f)); pruned.push(`mock/${f}`); }
    }
  }
  for (const dir of [OUT_REWRITE, OUT_FILTER]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!/\.(snippet|list)$/.test(f) || f.startsWith("_")) continue;
      if (!written.has(f)) {
        rmSync(join(dir, f));
        pruned.push(f);
      }
    }
  }
}

const totRules = pluginReport.reduce((a, b) => a + b.rules, 0);
const totRew = pluginReport.reduce((a, b) => a + b.rewrites, 0);
console.log(`转换完成: ${pluginReport.filter((p) => p.enabled).length}/${pluginReport.length} 个启用插件 -> ${written.size} 个文件`);
console.log(`  分流 ${totRules} 条 / 重写 ${totRew} 条 / MITM 主机名 ${allHostnames.size} 个`);
console.log(`  kelee 侧内部去重跳过 ${deduped} 条（跨源去重由 vendor-rules 的合并负责）`);
if (pruned.length) console.log(`  清理孤儿产物 ${pruned.length} 个: ${pruned.join(", ")}`);

const reasons = new Map();
for (const s of skipReport) reasons.set(s.reason, (reasons.get(s.reason) ?? 0) + 1);
console.log(`\n未转换/已丢弃共 ${skipReport.length} 条（逐条记账）:`);
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${r}`);

if (notes.length) {
  const byKind = new Map();
  for (const n of notes) byKind.set(n.kind, (byKind.get(n.kind) ?? 0) + 1);
  console.log(`\n⚠ 保真度提示 ${notes.length} 条（已转换但行为可能与源插件不同）:`);
  for (const [k, n] of byKind) console.log(`  ${String(n).padStart(4)}  ${k}`);
}

writeIfChanged(
  join(OUT_REWRITE, "_conversion-report.json"),
  JSON.stringify(
    { generated_note: "由 tools/convert-plugins.mjs 生成，勿手工编辑。", plugins: pluginReport, skipped: skipReport, notes },
    null,
    2,
  ) + "\n",
);

function writeIfChanged(dest, body) {
  const rel = dest.replace(ROOT + "/", "").replace(/\\/g, "/");
  const prev = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (prev === body) return;
  if (CHECK) {
    console.log(`  ! 需要更新: ${rel}（${(prev ?? "").split("\n").length} -> ${body.split("\n").length} 行）`);
    process.exitCode = 1;
    return;
  }
  writeFileSync(dest, body, "utf8");
  console.log(`  + ${rel}`);
}
