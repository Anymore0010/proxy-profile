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

/** `a.b c.d` -> `del(.a.b, .c.d)` */
const jsonDelToJq = (paths) => `'del(${paths.map((p) => `.${p}`).join(", ")})'`;

/** 转换 [Rewrite] 的一行。Loon = `<regex> <action> [args]`，QX = `<regex> url <action> [args]`。 */
function convertRewrite(line, plugin) {
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
    return `${pattern} url jsonjq-response-body ${jsonDelToJq(paths)}`;
  }
  if (a === "response-body-json-replace") {
    const toks = rest.trim().split(/\s+/).filter(Boolean);
    if (toks.length < 2 || toks.length % 2 !== 0) {
      return skip(plugin, "Rewrite", line, "response-body-json-replace 参数不成对"), null;
    }
    const sets = [];
    for (let i = 0; i < toks.length; i += 2) sets.push(`.${toks[i]} = ${toks[i + 1]}`);
    return `${pattern} url jsonjq-response-body '${sets.join(" | ")}'`;
  }
  if (a === "response-body-json-jq" || a === "request-body-json-jq") {
    const expr = rest.trim();
    if (!expr) return skip(plugin, "Rewrite", line, "json-jq 无表达式"), null;
    return `${pattern} url ${a.startsWith("response") ? "jsonjq-response-body" : "jsonjq-request-body"} ${expr}`;
  }
  if (a === "response-body" || a === "request-body") {
    if (!/\sresponse-body\s+/.test(rest)) {
      return skip(plugin, "Rewrite", line, `${a} 需要成对的 search/replace`), null;
    }
    return `${pattern} url ${a} ${rest}`;
  }
  if (a === "302" || a === "307") return `${pattern} url ${a} ${rest.trim()}`;

  // 注意措辞：这里是**转换器没实现**，不等于 QX 做不到。已核实的等价物：
  //   mock-response-body            -> script-echo-response / echo-response（返回固定 body）
  //   response-body-replace-regex   -> `url response-body <正则> response-body <替换>`
  //   header（重写请求 URL）          -> `url 302 <新URL>` / `url 307 <新URL>`
  // 写错措辞会把「没实现」传播成「做不到」，下次维护就不会去补了。
  skip(plugin, "Rewrite", line, `转换器未实现该动作（${action}）；QX 侧有等价物，见 TODO.md`);
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
  const m = line.match(/^(http-request|http-response)\s+(\S+)\s+(.*)$/);
  if (!m) {
    skip(plugin, "Script", line, "Loon 脚本化写法（`request/response if ${url} ~= ...`），QX 无等价语法");
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

/** 把脚本/资产镜像进仓库，返回仓库内相对路径；失败返回 null。 */
async function mirrorAsset(url) {
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

const claimedSigs = [];      // kelee 侧已产出的语义签名
const claimedExact = new Map(); // kelee 侧已产出的整行
const seeded = [];           // 参与比对的既有源（仅用于报告）
const isBodyRewrite = (l) => /\surl\s+(script-|jsonjq-)/.test(l);
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

for (const p of index.plugins) {
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
  const selfRel = `QuantumultX/rules/rewrite/kelee/${base}.snippet`;

  const argDefaults = parseArgumentDefaults(text);
  const filters = [];
  const rewrites = [];

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
    let r = convertRewrite(line, p.name);
    if (r && typeof r === "object" && r.needsJqInline) r = await tryInlineJq(r.pattern, line, p.name);
    if (r) rewrites.push(r);
  }
  for (const raw of sectionLines(text, "Script") ?? []) {
    const line = cleanRule(raw);
    if (!line) continue;
    const r = convertScript(line, p.name, argDefaults);
    if (r) rewrites.push(r.line);
  }

  // kelee 侧内部去重：同一 (正则, 动作) 只在**本插件集合内**判重，
  // 与**其他源**的跨源去重已移交 tools/vendor-rules.mjs 的合并步骤
  // （kelee 排第一个来源 = kelee 胜出，合并时按语义判据跳过后续重复）。
  const kept = [];
  for (const r of rewrites) {
    const pat = r.split(/\s+(?:url|url-and-header)\s+/)[0];
    if (!isBodyRewrite(r)) {
      kept.push(r);
      continue;
    }
    // 只在「会改写响应体」的动作上判重（reject 类重复幂等，可保留）。
    const sig = ruleSig(pat);
    const dupInKelee = claimedSigs.some((c) => sameTarget(sig, c.sig)) || claimedExact.has(r);
    if (dupInKelee) {
      deduped++;
      skip(p.name, "Rewrite", r, "与另一个 kelee 插件产出重复（保留先出现的那个）");
      continue;
    }
    claimedSigs.push({ sig, from: selfRel });
    claimedExact.set(r, selfRel);
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
  if (filters.length) {
    writeIfChanged(join(OUT_FILTER, `${base}.list`), [...header, "", ...filters, ""].join("\n"));
    written.add(`${base}.list`);
  }
  if (localized.length) {
    writeIfChanged(
      join(OUT_REWRITE, `${base}.snippet`),
      [...header, "", ...localized, "", `hostname = ${hosts.join(", ")}`, ""].join("\n"),
    );
    written.add(`${base}.snippet`);
  }
  pluginReport.push({ plugin: p.name, name: nm, enabled: true, rules: filters.length, rewrites: localized.length, hostnames: hosts.length });
}

// ---- 去重职责已移交 tools/vendor-rules.mjs 的合并步骤 ----
// 合并按 (正则,动作) + 语义判据在**源之间**去重，且 kelee 排第一个来源 = kelee 胜出。
// 所以这里不再生成 _exclusions.json（原机制要求目标资源仍是 rewrite_remote 条目，
// 而合并后它们已不是，清单永远落不了地）。

// ---- 清理本轮不再产出的文件（禁用/改名/删除插件都不会留下孤儿） ----
const pruned = [];
if (!CHECK) {
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
