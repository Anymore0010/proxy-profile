#!/usr/bin/env bun
/**
 * Vendors upstream Loon/Surge rule lists into this repository as Quantumult X
 * filter files, under QuantumultX/rules/.
 *
 * Why: the profile's remaining `opt-parser=true` entries depend on Quantumult X's
 * *runtime* resource parser. That has three problems:
 *   1. No fallback. If the upstream file or the parser script breaks, the rules
 *      disappear silently on the device.
 *   2. Rules the parser cannot express are dropped, surfaced only as an iOS
 *      notification that is easy to miss. Measured on fmz's AI.list: 2 `AND`
 *      rules silently lost.
 *   3. The conversion result is invisible — nothing to review before it runs.
 *
 * Vendoring converts once, here, and commits the result: reviewable in git,
 * no runtime parser needed, and any dropped rule is recorded in
 * QuantumultX/rules/CONVERSION.md.
 *
 *   bun tools/vendor-rules.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { convertRuleList } from "./convert-rules.mjs";
import { ruleSig, sameTarget } from "./lib/rule-target.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = JSON.parse(readFileSync(join(ROOT, "tools", "sources.json"), "utf8"));

const OUT_DIR = join(ROOT, "QuantumultX", "rules");
mkdirSync(OUT_DIR, { recursive: true });

/**
 * 合并组：把多个上游规则源合成一个本地文件（用同一个策略）。
 *
 * 用途：AI 相关的三条（fmz AI.list + bm7 OpenAI + bm7 Anthropic）本就是同一类分流，
 * 合成一条便于维护，也避免同一域名被多条规则以不同策略重复命中。
 */
const mergeGroups = src.rule_merges ?? [];

/** Filters flagged `vendor: true` are fetched, converted and committed locally. */
const toVendor = src.filters.filter((f) => f.vendor);
// 带 merges 的分流条目走下面的合并路径（不按单一上游转换）。
const filterMergeGroups = src.filters.filter((f) => f.merges?.length && f.local_file);
const toVendorOnly = toVendor.filter((f) => !f.merges?.length);

if (toVendor.length === 0 && mergeGroups.length === 0 && filterMergeGroups.length === 0) {
  console.log("No filters marked vendor:true — nothing to do.");
  process.exit(0);
}

/** 上游 URL -> 仓库内快照相对路径（与 fetch-snapshot 的 localPathFor 一致）。 */
/**
 * 合并产物的**分段标记**：每个来源的规则前插一段注释，标明这一块的出处。
 * 便于 review「哪一条来自哪里」——合并后单看文件是分不清的。
 * 去重方向是「先到者胜」：同一 (键) 在后面的来源里会被跳过，所以
 * 靠前的来源优先级更高（kelee 通常排第一）。
 */
function sectionMarker(idx, src, count) {
  const bar = "#".repeat(64);
  const where = src.url ?? src.local_file ?? "";
  return [
    bar,
    `# 第 ${idx} 块来源: ${src.tag ?? ""}`,
    `#   ${where}`,
    `#   本块贡献 ${count} 条（与前面重复的已跳过，先到者优先）`,
    bar,
  ];
}

function snapshotPathFor(url) {
  const m = (url ?? "").match(/^https:\/\/raw\.githubusercontent\.com\/(.+)$/);
  if (m) return `snapshot/github.com/${m[1]}`;
  const m2 = (url ?? "").match(/^https:\/\/([^/]+)\/(.+)$/);
  return m2 ? `snapshot/host/${m2[1]}/${m2[2]}` : null;
}

const report = [];
let failures = 0;

for (const f of toVendorOnly) {
  process.stdout.write(`vendoring ${f.id} … `);
  let text;
  try {
    const res = await fetch(f.upstream_url, { headers: { // kelee.one / rule.kelee.one 只对 Loon 的 UA 放行（其余返回 Cloudflare 403）
      "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (e) {
    failures++;
    console.log(`FAILED (${e.message})`);
    report.push({ id: f.id, url: f.upstream_url, ok: false, error: e.message });
    continue;
  }

  const { rules, dropped, notes, stats } = convertRuleList(text, { policy: f.policy });

  // Header records provenance so the file is self-explanatory when reviewed.
  const header = [
    `# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑`,
    `# 来源（上游）: ${f.upstream_url}`,
    `# 转换说明: Loon/Surge 规则 → Quantumult X 分流格式`,
    `# 规则数: ${rules.length}${dropped.length ? `  已丢弃: ${dropped.length}（见 rules/CONVERSION.md）` : ""}`,
    `# 重新生成: bun tools/vendor-rules.mjs`,
    "",
  ];

  // 单源 vendor 也插一段块标记：所有生成文件的头部格式保持一致，
  // 便于「这份规则来自哪」在同一种位置查看。
  const body =
    header
      .concat(sectionMarker(1, { tag: f.tag ?? f.id, url: f.upstream_url }, rules.length))
      .concat(rules)
      .join("\n") + "\n";
  const file = join(ROOT, "QuantumultX", "rules", f.vendored_as);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  console.log(`${rules.length} rules${dropped.length ? `, ${dropped.length} dropped` : ""}${notes.length ? `, ${notes.length} adjusted` : ""} -> ${f.vendored_as}`);
  report.push({ id: f.id, url: f.upstream_url, ok: true, count: rules.length, dropped, notes, stats, file: f.vendored_as });
}

// ---- 分流合并组 ------------------------------------------------------------
// 与 rewrite 合并同样的思路，但分流规则是 `type, value, policy` 三元组：
// 去重键 = (type, value)，**策略必须一致**才合并 —— 策略不同的同名规则合并后
// 只有一个能生效，会静默改变行为，所以那种情况报错让人来处理。
{
  for (const f of filterMergeGroups) {
    process.stdout.write(`合并 ${f.id} … `);
    const body = []; // 逐块累积（含分段标记）
    let idx0 = 0;
    let total = 0;
    const seen = new Map(); // key -> policy，用于检测策略冲突
    let failed = false;
    let conflicts = 0;
    const perSource = [];
    for (const m of f.merges) {
      let text = null;
      if (m.local_file) {
        const abs = join(ROOT, m.local_file);
        if (existsSync(abs)) text = readFileSync(abs, "utf8");
      } else if (m.url) {
        // 上游 URL：先看快照，其次本仓库已 vendored 的产物
        const snapRel = snapshotPathFor(m.url);
        const snapAbs = snapRel ? join(ROOT, snapRel) : null;
        if (snapAbs && existsSync(snapAbs)) text = readFileSync(snapAbs, "utf8");
        else {
          try {
            const res = await fetch(m.url, { headers: { "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0" } });
            if (res.ok) text = await res.text();
          } catch { /* 下面统一按失败处理 */ }
        }
      }
      if (!text) {
        failed = true;
        console.log(`FAILED 取不到 ${m.tag ?? m.url ?? m.local_file}`);
        report.push({ id: f.id, ok: false, error: "取不到内容", url: m.tag ?? m.url ?? m.local_file });
        continue;
      }
      // 上游多为 Surge/Loon 语法时用 convertRuleList；本仓库产物已是 QX 语法、直接收。
      const isQx = m.local_file && m.local_file.endsWith("AWAvenue.list");
      const rules = isQx
        ? text.split(/\r?\n/).map((x) => x.split("//")[0].trim()).filter((x) => x && !x.startsWith("#"))
        : convertRuleList(text, { policy: f.policy }).rules;
      let added = 0;
      const blockLines = [];
      for (const r of rules) {
        const parts = r.split(",").map((x) => x.trim());
        if (parts.length < 2) continue;
        const key = `${parts[0].toLowerCase()}\t${parts[1].toLowerCase()}`;
        // 策略来源分两类，**不能一刀切**：
        //  · 上游 url 源（fmz/bm7/AWAvenue）原本靠 force-policy=reject 生效；
        //    bm7 的 Advertising.list 策略列甚至是字面量 "advertising"（28 万条），
        //    不覆写成 reject 会产出无效策略。=> force_policy（默认 reject）
        //  · 本仓库的 kelee 产物自带逐行策略，里面**有 direct 白名单**
        //    （如 host, init.sms.mob.com, direct —— 短信/推送验证类）。
        //    若给整份文件设 force-policy 会把这些白名单一起改成 reject，
        //    用户设备上会立刻出现功能故障。=> preserve_policy
        const pol = m.preserve_policy ? parts[parts.length - 1] : (m.force_policy ?? f.policy ?? "reject");
        const val = parts.slice(1, -1).join(", ") || parts[1];
        const line = `${parts[0]}, ${val}, ${pol}`;
        const prev = seen.get(key);
        if (prev !== undefined) {
          if (prev !== pol) conflicts++;
          continue;
        }
        seen.set(key, pol);
        blockLines.push(line);
        added++;
      }
      // 分段标记放在本块规则**之前**，标明这一块的出处
      if (added) {
        body.push(...sectionMarker(idx0 + 1, m, added));
        body.push(...blockLines);
        total += added;
      }
      idx0++;
      perSource.push(`${m.tag ?? (m.url ?? m.local_file).split("/").pop()}: ${added}`);
    }
    if (conflicts) {
      console.error(`WARN ${f.id}: ${conflicts} 条同名规则策略不一致，已保留先出现的那个`);
    }
    if (failed || total === 0) {
      console.log(`跳过写入 ${f.local_file} —— ${existsSync(join(ROOT, f.local_file)) ? "已保留上一次的完整版本" : "无旧版本可保留"}`);
      report.push({ id: f.id, ok: false, error: "部分来源失败或结果为空", file: f.local_file, kept: true });
      continue;
    }
    const header = [
      "# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑",
      `# 合并来源（${f.merges.length} 个，按顺序优先）:`,
      ...f.merges.map((m) => `#   ${m.tag ?? ""}  ${m.url ?? m.local_file}`),
      "# 去重键: (类型, 值)；策略取先出现的来源",
      `# 规则数: ${total}`,
      "# 重新生成: bun tools/vendor-rules.mjs",
      "",
      ...body,
      "",
    ];
    const file = join(ROOT, f.local_file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, header.join("\n"));
    console.log(`${total} 条（${perSource.join(" | ")}）-> ${f.local_file}`);
    report.push({ id: f.id, ok: true, count: total, dropped: [], notes: [],
      url: f.merges.map((m) => m.url ?? m.local_file).join(" + "), file: f.local_file });
  }
}

// ---- rewrite 合并组 --------------------------------------------------------
// 把多个 rewrite 资源合成**一份本仓库文件**：按 (正则, 动作) 去重，kelee 侧优先。
// 目的：条目更少、同一响应体不会被两套脚本重复处理，且产物可 review。
//
// 为什么不是简单拼接：bm7 的 Advertising.conf 是纯 reject（幂等），
// fmz 的 rewrite.snippet 与 kelee 的 BlockAdvertisers.conf 含 script-/jsonjq- 规则 ——
// 重复命中的话同一个 body 会被处理两次。所以按 (正则, 动作) 去重，
// 且**kelee 的条目排在前面**（与 [rewrite_remote] 里 kelee 优先的方向一致）。
{
  const mergeRewrites = src.rewrites.filter((r) => r.merges?.length && r.local_file);
  // 合并前先收集「独立条目」的语义签名：那些**不属于任何合并组**、但仍作为
  // rewrite_remote 条目启用的资源（主要是逐个 App 的 kelee .conf，如 Zhihu/RedPaper）。
  // 它们更具体、且方向也是 kelee 优先，所以合并时要把重叠项排除掉 ——
  // 否则同一个响应体会被两套脚本处理（validate 的跨源重复检查会直接报错，
  // 实测合并后出现 35 条：kelee/Zhihu.conf <-> 广告拦截合集MAX.list）。
  const mergedInputs = new Set();
  for (const r0 of src.rewrites) for (const m0 of r0.merges ?? []) {
    if (m0.local_file) mergedInputs.add(m0.local_file);
  }
  const standaloneSigs = [];
  for (const r0 of src.rewrites) {
    if (!r0.enabled || !r0.local_file) continue;
    if (r0.merges?.length) continue;              // 合并组的产物，跳过
    if (mergedInputs.has(r0.local_file)) continue; // 合并组的输入，跳过
    const abs0 = join(ROOT, r0.local_file);
    if (!existsSync(abs0)) continue;
    for (const line of readFileSync(abs0, "utf8").split(/\r?\n/)) {
      const tt = line.trim();
      const mm0 = tt.match(/^(\S+)\s+url(?:-and-header)?\s+(\S+)/);
      if (!mm0) continue;
      if (!/^(script-|jsonjq-)/.test(mm0[2].toLowerCase())) continue;
      standaloneSigs.push({ sig: ruleSig(mm0[1]), from: r0.tag });
    }
  }

  for (const r of mergeRewrites) {
    process.stdout.write(`合并 ${r.id} … `);
    const bodySigs = []; // 本组内已收的 body-rewrite 语义签名（kelee 排第一 -> kelee 胜出）
    let semanticallyDeduped = 0;
    let excludedByStandalone = 0;
    const all = [];
    const seen = new Set();
    let failed = false;
    const perSource = [];
    const hostnames = new Set();
    const rwBody = []; // 逐块累积（含分段标记）
    let rwIdx = 0;
    let rwCount = 0;   // 实际产出的规则行数（守卫与计数都用它；all 已不再被 push）
    // raw_rewrite：内联在 sources.json 里的手写规则（如 Anymore 自用增强的 41 条）。
    // 放在 merges **之前** —— 它们是用户手写的、优先级最高。
    const sources = [];
    if (r.raw_rewrite?.length) sources.push({ tag: "内联手写规则（raw_rewrite）", raw: r.raw_rewrite });
    sources.push(...r.merges);
    for (const m of sources) {
      if (m.raw) {
        let added0 = 0;
        const blockLines0 = [];
        for (const line of m.raw) {
          const tt = line.trim();
          if (!tt) continue;
          if (/^hostname\s*=/i.test(tt)) {
            for (const h of tt.split("=", 2)[1].split(",")) {
              const v = h.trim();
              if (v && /^[A-Za-z0-9*?._-]+$/.test(v) && !v.startsWith("-")) hostnames.add(v);
            }
            continue;
          }
          if (tt.startsWith("#")) continue;
          const mm = tt.match(/^(\S+)\s+url(?:-and-header)?\s+(\S+)/);
          if (!mm) continue;
          const key = `${mm[1]}\t${mm[2].toLowerCase()}`;
          if (seen.has(key)) continue;
          seen.add(key);
          blockLines0.push(tt);
          added0++;
        }
        if (added0) {
          rwBody.push(...sectionMarker(rwIdx + 1, m, added0));
          rwBody.push(...blockLines0);
          // ⚠ 必须累加 rwCount：漏了会让头部「重写规则数」比实际少 raw_rewrite 的条数
          // （实测 2377 vs 实际 2418，差 41），并让「整组只有 raw_rewrite」的条目
          // 被下面的 `rwCount === 0` 误判为「结果为空」而跳过写入。
          rwCount += added0;
        }
        rwIdx++;
        perSource.push(`${m.tag}: ${added0} 条`);
        continue;
      }
      let text = null;
      // local_file：直接读本仓库文件（kelee 产物）
      if (m.local_file) {
        const abs = join(ROOT, m.local_file);
        if (existsSync(abs)) text = readFileSync(abs, "utf8");
      } else if (m.url) {
        // 上游 URL：读 fetch-snapshot 镜像好的快照（保证离线可重建、结果确定）。
        // 不用 _raw：合并**自己**负责去重（见下面的语义判据），
        // 读未排除的原始副本会让被 kelee 顶掉的规则回灌。
        const snapAbs = (() => { const r0 = snapshotPathFor(m.url); return r0 ? join(ROOT, r0) : null; })();
        if (snapAbs && existsSync(snapAbs)) text = readFileSync(snapAbs, "utf8");
        else {
          try {
            const res = await fetch(m.url, { headers: { "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0" } });
            if (res.ok) text = await res.text();
          } catch { /* 下面统一按失败处理 */ }
        }
      }
      if (!text) {
        failed = true;
        console.log(`FAILED 取不到 ${m.tag ?? m.url ?? m.local_file}`);
        report.push({ id: r.id, url: m.tag ?? m.url ?? m.local_file, ok: false, error: "取不到内容" });
        continue;
      }
      let added = 0;
      let skippedNonRewrite = 0; // 必须**每个来源独立计数**：累加会让日志把 fmz 的 2791 行记到每个来源头上
      const blockLines = [];
      for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        if (/^hostname\s*=/i.test(t)) {
          for (const h of t.split("=", 2)[1].split(",")) {
            const v = h.trim();
            if (v && /^[A-Za-z0-9*?._-]+$/.test(v) && !v.startsWith("-")) hostnames.add(v);
          }
          continue;
        }
        if (t.startsWith("#")) continue;
        // 只收**重写行**。上游聚合资源里混着分流规则（`host, x, reject` 之类），
        // 放进 rewrite 资源是无效的 —— QX 的 rewrite 段只解析 `… url <动作> …`，
        // 其余行会被静默忽略（实测 fmz 的 rewrite.snippet 里就有约 2700 行是分流）。
        const mm = t.match(/^(\S+)\s+url(?:-and-header)?\s+(\S+)/);
        if (!mm) { skippedNonRewrite++; continue; }
        // 去重键 = (URL正则, 动作)，**忽略脚本 URL**（跨源同一动作会钉不同脚本版本）
        const key = `${mm[1]}\t${mm[2].toLowerCase()}`;
        if (seen.has(key)) continue;
        const isBody = /^(script-|jsonjq-)/.test(mm[2].toLowerCase());
        if (isBody) {
          // 会改写响应体的规则要做**语义**判重：上游常把同一接口写成不同正则
          // （`^https:\/\/x` vs `^https?:\/\/x`），只比字符串会漏，
          // 导致同一个 body 被两套脚本依次处理（本项目反复踩的坑）。
          // 因为 kelee 排在第一个来源，先到者即 kelee —— 方向就是「kelee 胜出」。
          const sig = ruleSig(mm[1]);
          const dup = bodySigs.find((e) => sameTarget(sig, e.sig));
          if (dup) { semanticallyDeduped++; continue; }
          // 与独立条目（逐个 App 的 kelee .conf）重叠 -> 让独立条目负责
          if (standaloneSigs.some((e) => sameTarget(sig, e.sig))) { excludedByStandalone++; continue; }
          bodySigs.push({ sig, from: m.tag ?? m.url ?? m.local_file });
        }
        seen.add(key);
        blockLines.push(t);
        added++;
      }
      if (added) {
        rwBody.push(...sectionMarker(rwIdx + 1, m, added));
        rwBody.push(...blockLines);
        rwCount += added;
      }
      rwIdx++;
      perSource.push(`${m.tag ?? (m.url ?? m.local_file).split("/").pop()}: ${added} 条${skippedNonRewrite ? `，丢弃 ${skippedNonRewrite} 条非重写行` : ""}`);
    }
    // 与 fetch-snapshot 一致：任一源失败就不覆盖已提交的完整版本
    if (failed || rwCount === 0) {
      const keep = existsSync(join(ROOT, r.local_file)) ? "已保留上一次的完整版本" : "无旧版本可保留";
      console.log(`跳过写入 ${r.local_file} —— ${keep}`);
      report.push({ id: r.id, ok: false, error: failed ? "部分来源失败，保留旧版" : "结果为空", file: r.local_file, kept: true });
      continue;
    }
    const header = [
      "# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑",
      `# 合并来源（${r.merges.length} 个，按顺序优先）:`,
      ...r.merges.map((m) => `#   ${m.tag ?? ""}  ${m.url ?? m.local_file}`),
      `# 去重键: (URL正则, 动作)，忽略脚本 URL`,
      `# 重写规则数: ${rwCount}`,
      `# 重新生成: bun tools/vendor-rules.mjs`,
      "",
      ...rwBody,
      "",
      `hostname = ${[...hostnames].sort().join(", ")}`,
      "",
    ];
    const file = join(ROOT, r.local_file);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, header.join("\n"));
    console.log(`${rwCount} 条（${perSource.join(" | ")}）${semanticallyDeduped ? `，组内去重 ${semanticallyDeduped} 条` : ""}${excludedByStandalone ? `，让给独立条目 ${excludedByStandalone} 条` : ""} -> ${r.local_file}`);
    report.push({ id: r.id, ok: true, count: rwCount, dropped: [], notes: [],
      url: (r.merges ?? []).map((m) => m.url ?? m.local_file).join(" + "), file: r.local_file });
  }
}

// ---- 合并组 ----------------------------------------------------------------
for (const g of mergeGroups) {
  // raw_rewrite：直接给出最终 QX 规则（无需从上游转换），用于「上游是 JS 脚本、
  // 规则要自己写」的情况，例如京东比价。
  if (g.raw_rewrite?.length) {
    process.stdout.write(`合并 ${g.id} … `);
    // 注意：这里**不**改写脚本 URL —— 交给 fetch-snapshot 统一处理。
    // 原因：改写需要快照副本已存在，而副本由 fetch-snapshot 创建，
    // 若在此改写会形成死结（首次永远不改 -> 永远不进快照）。
    // fetch-snapshot 会扫描 QuantumultX/rules/* 并把脚本镜像 + 改写。
    const header = [
      "# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑",
      ...(g.sources ?? []).map((u) => `# 参考来源: ${u}`),
      `# 规则数: ${g.raw_rewrite.filter((l) => !l.startsWith("hostname")).length}`,
      "# 重新生成: bun tools/vendor-rules.mjs",
      "",
    ];
    const file = join(ROOT, "QuantumultX", "rules", g.out);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      header
        .concat(sectionMarker(1, { tag: "内联规则（sources.json 的 raw_rewrite）" }, g.raw_rewrite.filter((l) => !l.startsWith("hostname")).length))
        .concat(g.raw_rewrite)
        .join("\n") + "\n",
    );
    console.log(`${g.raw_rewrite.length} 行 -> ${g.out}`);
    report.push({ id: g.id, url: (g.sources ?? []).join(" + "), ok: true,
      count: g.raw_rewrite.filter((l) => !l.startsWith("hostname")).length,
      dropped: [], notes: [], file: g.out });
    continue;
  }
  process.stdout.write(`合并 ${g.id} … `);
  const all = [];
  const rmBody = []; // 逐块累积（含分段标记）
  let rmIdx = 0;
  let rmCount = 0;
  const seenKeys = new Set();
  let perSource = [];
  let groupFailed = false; // 本组任一源失败 -> 不覆盖已提交的产物
  for (const u of g.sources) {
    try {
      const res = await fetch(u, { headers: { // kelee.one / rule.kelee.one 只对 Loon 的 UA 放行（其余返回 Cloudflare 403）
      "User-Agent": "Loon/998 CFNetwork/3896.200.41 Darwin/27.2.0" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { rules } = convertRuleList(await res.text(), { policy: g.policy, forcePolicy: true });
      // exclude_domains：这些域名由别的条目负责，合并时必须剔除，
      // 否则会因顺序把它们抢到本策略下（实测 Apple relay 域名被抢到「人工智能」）。
      const excluded = new Set((g.exclude_domains ?? []).map((x) => x.toLowerCase()));
      let added = 0;
      const blockLines = [];
      for (const r of rules) {
        const dom = r.split(",")[1]?.trim().toLowerCase();
        if (dom && excluded.has(dom)) continue;
        if (seenKeys.has(r)) continue; // 跨来源去重（同一域名+同一策略）
        seenKeys.add(r);
        blockLines.push(r);
        added++;
      }
      if (added) {
        // 可读标签：从 URL 末段推出来源名；否则「来源」处会是裸 URL、
        // 且与下一行的 URL 重复打两遍（实测 Google.list 就是那样）。
        const label = (() => {
          const seg = u.split("/");
          const file = seg[seg.length - 1];
          const host = u.includes("kelee.one") ? "kelee" : (seg[2] ?? "");
          return `${host} ${file}`;
        })();
        rmBody.push(...sectionMarker(rmIdx + 1, { tag: label, url: u }, added));
        rmBody.push(...blockLines);
        rmCount += added;
      }
      rmIdx++;
      perSource.push(`${u.split("/").slice(-2).join("/")}: ${added}`);
    } catch (e) {
      failures++;
      groupFailed = true;
      console.log(`FAILED (${e.message})`);
      report.push({ id: g.id, url: u, ok: false, error: e.message });
    }
  }
  // 与 fetch-snapshot 的「抓全才覆盖」一致：只要有一个源失败（或结果为空），
  // 就**跳过写入**，保留上一次提交的完整版本。
  // 否则 merge-google 里 YouTube 源一挂，已提交的 Google.list 会被重写成只剩
  // Google 的 711 条（YouTube 196 条消失），而 CI 是先 commit 再变红 ——
  // 设备下周就会拉到残缺规则，直到下次成功才自愈。
  if (groupFailed || rmCount === 0) {
    const keep = existsSync(join(ROOT, "QuantumultX", "rules", g.out))
      ? "已保留上一次的完整版本"
      : "无旧版本可保留（本次不写入）";
    console.log(`跳过写入 ${g.out} —— ${keep}`);
    report.push({ id: g.id, url: g.sources.join(" + "), ok: false,
      error: groupFailed ? "部分来源失败，保留旧版" : "结果为空，保留旧版", file: g.out, kept: true });
    continue;
  }
  const header = [
    "# 由 tools/vendor-rules.mjs 自动生成 —— 请勿手工编辑",
    `# 合并来源（${g.sources.length} 个）:`,
    ...g.sources.map((u) => `#   ${u}`),
    `# 统一策略: ${g.policy}`,
    `# 规则数: ${rmCount}（已跨来源去重）`,
    ...perSource.map((x) => `#   各源贡献 ${x}`),
    "# 重新生成: bun tools/vendor-rules.mjs",
    "",
  ];
  const file = join(ROOT, "QuantumultX", "rules", g.out);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, header.concat(rmBody).join("\n") + "\n");
  console.log(`${rmCount} 条 -> ${g.out}`);
  report.push({ id: g.id, url: g.sources.join(" + "), ok: true, count: rmCount, dropped: [], notes: [], file: g.out });
}

// ---- conversion report -----------------------------------------------------
const lines = [
  "# 规则自动转换报告",
  "",
  "由 `tools/vendor-rules.mjs` 生成。这些规则原本依赖 Quantumult X 的**运行时资源解析器**",
  "（`opt-parser=true`），现已在本仓库内预转换为 Quantumult X 原生格式。",
  "",
  "好处：不依赖运行时解析器、结果可在 git 中审查、被丢弃的规则有记录（而不是只在 iOS 上弹一条通知）。",
  "",
  "| 上游来源 | 转换后文件 | 规则数 | 丢弃 |",
  "|---|---|---|---|",
];
for (const r of report) {
  if (!r.ok) {
    lines.push(`| ${r.url} | — | **抓取失败**：${r.error} | — |`);
  } else {
    // file 可能是全仓库路径（合并路径推的是 local_file）或相对路径（单源 vendor）。
    // 两种形态都要兼容：否则会拼出 QuantumultX/rules/QuantumultX/rules/… 这种坏路径。
    // upstream 在合并路径里没有单一 url，用来源列表（已 join）兜底。
    const filePath = r.file
      ? (r.file.startsWith("QuantumultX/") ? r.file : `QuantumultX/rules/${r.file}`)
      : "(未写入)";
    lines.push(`| ${r.url ?? "(见文件内分段注释)"} | \`${filePath}\` | ${r.count} | ${r.dropped?.length ?? 0} |`);
  }
}
lines.push("", "## 选项调整（规则保留）", "");
const withNotes = report.filter((r) => r.ok && (r.notes ?? []).length);
if (withNotes.length === 0) {
  lines.push("无。");
} else {
  lines.push("这些规则**被保留**，只是移除了 Quantumult X 不支持的选项：", "");
  for (const r of withNotes) {
    lines.push(`### ${r.id}`, "");
    for (const n of r.notes) lines.push(`- \`${n.rule}\`  \n  ${n.note}`);
    lines.push("");
  }
}
lines.push("", "## 丢弃的规则", "");
const withDrops = report.filter((r) => r.ok && r.dropped.length);
if (withDrops.length === 0) {
  lines.push("无。");
} else {
  lines.push("Quantumult X 的分流不支持 `AND` / `OR` / `NOT` 组合规则（官方 sample.conf 中不存在这些类型）。", "拆开写会放宽匹配条件、拦截到不该拦的流量，因此选择丢弃：", "");
  for (const r of withDrops) {
    lines.push(`### ${r.id}`, "");
    for (const d of r.dropped) lines.push(`- \`${d.rule}\`  \n  原因：${d.reason}`);
    lines.push("");
  }
}
writeFileSync(join(OUT_DIR, "CONVERSION.md"), lines.join("\n") + "\n");
// Machine-readable status so the workflow's failure step can see vendored-rule
// failures too (it previously only read snapshot/index.json).
const status = {
  total: report.length,
  ok: report.filter((r) => r.ok).length,
  failed: failures,
  rules: report.filter((r) => r.ok).reduce((a, r) => a + r.count, 0),
  resources: report.map((r) => ({
    id: r.id,
    upstream: r.url,
    file: r.ok
      ? (r.file?.startsWith("QuantumultX/") ? r.file : `QuantumultX/rules/${r.file}`)
      : null,
    rules: r.ok ? r.count : null,
    dropped: r.ok ? r.dropped.length : null,
    adjusted: r.ok ? (r.notes ?? []).length : null,
    error: r.ok ? null : r.error,
  })),
};
writeFileSync(join(OUT_DIR, "status.json"), JSON.stringify(status, null, 2) + "\n");
console.log(`Wrote ${relative(ROOT, join(OUT_DIR, "CONVERSION.md"))}${failures ? ` (${failures} failure(s))` : ""}`);
// Same policy as fetch-snapshot.mjs: a single broken upstream must not abort the
// whole weekly refresh. Failures are recorded in the report; `--strict` (used by
// the workflow's final check) turns them into a non-zero exit.
if (failures) {
  console.warn(`${failures} vendored upstream(s) failed — see QuantumultX/rules/CONVERSION.md`);
  if (process.argv.includes("--strict")) process.exitCode = 1;
}
