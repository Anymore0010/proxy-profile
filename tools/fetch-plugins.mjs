#!/usr/bin/env bun
// 从源 Loon 配置的 [Plugin] 段抓取全部插件，原样存到 vendor/loon-plugins/。
//
// 为什么要保存原始副本：
//   kelee.one 对普通 UA（curl / 无头浏览器）返回 Cloudflare 403，只有 Loon 的
//   User-Agent 才能通过。若不落盘，这些"用户实际在用"的插件内容随时可能再次取不到，
//   而它们正是迁移 QX 的唯一事实来源。
//
// 用法：bun tools/fetch-plugins.mjs [--force]
//   --force  即使本地已存在也重新抓取（默认：已存在则跳过，避免无谓改动）

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOON_DIR = join(ROOT, "legacy", "loon");
const OUT_DIR = join(ROOT, "vendor", "loon-plugins");
const FORCE = process.argv.includes("--force");

// Loon 的 UA 是绕过 Cloudflare 的钥匙；其余头按抓包结果带上。
const HEADERS = {
  "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0",
  accept: "*/*",
  "accept-language": "zh-CN,zh-Hans;q=0.9",
};

function findLoonConfig() {
  const f = readdirSync(LOON_DIR).filter((n) => n.endsWith(".lcf"));
  if (!f.length) throw new Error(`legacy/loon 下没有 .lcf：${LOON_DIR}`);
  return join(LOON_DIR, f.sort().pop());
}

// 按行收集，遇到下一个 [Section] 即停。不要用 \Z —— 那是 PCRE 转义，
// JS 里会退化成字面量 "Z"，把段落截断在一处随机的 Z 上（实测 40 条只剩 29 条）。
function sectionBody(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n");
}

function parsePlugins(text) {
  const body = sectionBody(text, "Plugin");
  if (body === null) throw new Error("源配置里没有 [Plugin] 段");
  const out = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("http")) continue;
    const url = line.split(",")[0].trim();
    const policy = line.match(/policy=([^,\s]+)/);
    out.push({
      url,
      name: url.split("/").pop().split("?")[0],
      enabled: /enabled=true/.test(line),
      policy: policy ? policy[1] : null,
    });
  }
  return out;
}

async function fetchOne(p, attempt = 0) {
  try {
    const res = await fetch(p.url, { headers: HEADERS, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 200) throw new Error(`响应过小 (${buf.length}B)，疑似拦截页`);
    return { buf, status: res.status };
  } catch (e) {
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
      return fetchOne(p, attempt + 1);
    }
    throw e;
  }
}

const cfgPath = findLoonConfig();
const plugins = parsePlugins(readFileSync(cfgPath, "utf8"));
mkdirSync(OUT_DIR, { recursive: true });
console.log(`源配置: ${cfgPath.replace(ROOT + "/", "")}`);
console.log(`[Plugin] 条目: ${plugins.length}  ->  ${OUT_DIR.replace(ROOT + "/", "")}/\n`);

const index = [];
let fetched = 0,
  skipped = 0,
  failed = 0;

for (const p of plugins) {
  const dest = join(OUT_DIR, p.name);
  if (existsSync(dest) && !FORCE) {
    const buf = readFileSync(dest);
    index.push({
      ...p,
      file: `vendor/loon-plugins/${p.name}`,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      source: "cache",
    });
    skipped++;
    console.log(`  = ${p.name}  (本地已存在，跳过)`);
    continue;
  }
  try {
    const { buf } = await fetchOne(p);
    writeFileSync(dest, buf);
    index.push({
      ...p,
      file: `vendor/loon-plugins/${p.name}`,
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
      source: "network",
    });
    fetched++;
    console.log(`  + ${p.name}  ${buf.length}B`);
  } catch (e) {
    failed++;
    index.push({ ...p, file: null, error: String(e.message) });
    console.log(`  ! ${p.name}  失败: ${e.message}`);
  }
}

// 时间戳刻意不写入：与构建脚本同样的理由——生成物不能带易变值。
const meta = {
  note: "kelee.one 的 Loon 插件原样副本。抓取需要 Loon 的 User-Agent（否则 Cloudflare 403）。",
  source_config: cfgPath.replace(ROOT + "/", ""),
  count: index.length,
  fetched,
  skipped,
  failed,
  plugins: index,
};
writeFileSync(join(OUT_DIR, "index.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");

console.log(`\n完成: ${fetched} 新抓 / ${skipped} 跳过 / ${failed} 失败`);
if (failed) {
  // **不要**因此退出非零：抓取失败时旧副本仍在（「先抓后覆盖」的设计），
  // convert-plugins 会照常用上一份内容 —— 链路不断。
  // 若在这里 process.exit(1)，CI 的这一步直接失败、后续步骤全部不跑，
  // 等于「一个插件 403 就跳过整周刷新」。失败明细在 index.json 里，
  // 由 workflow 最后的「Fail if any upstream resource is broken」步骤统一上报。
  console.error(`⚠ ${failed} 个插件抓取失败（保留旧副本，链路继续）——明细见 index.json`);
}
