/**
 * 判断两条 Quantumult X rewrite 的 URL 正则是否命中「同一个接口」。
 *
 * 用于跨源重复检测：两条会改写请求/响应体的规则（script-* / jsonjq-*）
 * 命中同一 URL 时，同一个 body 会被先后处理两次 —— QX 不报错，结果不可预期。
 *
 * 为什么不能用「整行文本比对」：跨源重复的真实形态是同一接口、不同正则写法。
 * 为什么不能用「分词后交集」：`api`、`https`、`homepage` 这类通用词到处都是，
 *   实测把「api.pinduoduo.com/api/alexa/homepage/hub」与
 *   「api.u51.com/liabilitygateway/api/v1/homepage/liabilityline」判成重复（假阳性）。
 * 正确判据：**域名**相同（或一方是另一方的子域）+ 至少 2 个共同的**路径词元**。
 */

const TLD = /\.(com|cn|net|org|io|tv|me|xyz|top|cc|co|info|biz|app|site|mobi|gov|edu|club|shop)$/;
/** 出现在域名里但没有区分度的词，不能作为「同一域名」的依据。 */
const GENERIC = new Set(["api", "www", "m", "mobile", "app", "static", "cdn", "img", "data", "s"]);

/**
 * 抽出正则里出现的所有域名候选。
 * 例：`^https:\/\/(spclient\.wg\.spotify\.com|.*-spclient\.spotify\.com(:443)?)\/...`
 *     -> {"spclient.wg.spotify.com", "spclient.spotify.com"}
 */
function domainsOf(pat) {
  const plain = pat.replace(/\\/g, "").toLowerCase();
  const out = new Set();
  for (const m of plain.matchAll(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/g)) {
    const d = m[0].replace(/^\.+|\.+$/g, "");
    if (TLD.test(d)) out.add(d);
  }
  return out;
}

/** 路径词元（去掉域名与通用词、长度 ≥4）。 */
function pathTokensOf(pat) {
  return new Set(
    pat
      .replace(/\\/g, "")
      .replace(/\^|\$|\(\?:|\(|\)|\?|:443|\*/g, " ")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 4 && t !== "https" && t !== "http"),
  );
}

export function ruleSig(pat) {
  const domains = domainsOf(pat);
  const pathTokens = pathTokensOf(pat);
  // 路径词元里若混入域名片段（如 amap/cainiao），去掉，避免同域不同接口互相误判
  for (const d of domains) for (const w of d.split(".")) pathTokens.delete(w);
  return { domains, pathTokens };
}

/**
 * 剥掉无区分度的首标签：`api.pinduoduo.com` -> `pinduoduo.com`。
 * 注意：**不能**因此跳过整个域名 —— `api.*` 在广告类规则里极常见，
 * 跳过会让「同 api 主机、同路径、不同写法」的重复全部漏报。
 * 正确做法是剥掉前缀后参与比较（GENERIC 只影响「用哪个名字比」，不决定「比不比」）。
 */
function coreDomain(d) {
  const parts = d.split(".");
  // 至少保留「主域 + 后缀」两段
  return parts.length > 2 && GENERIC.has(parts[0]) ? parts.slice(1).join(".") : d;
}

/** 两条域名是否指同一主机（相等，或一方是另一方的子域）。 */
function sameHost(a, b) {
  for (const x0 of a) {
    const x = coreDomain(x0);
    for (const y0 of b) {
      const y = coreDomain(y0);
      if (x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)) return true;
    }
  }
  return false;
}

/**
 * 出现在路径里但区分度很低的词：它们描述「这是什么类型的资源」而非「哪个接口」，
 * 单靠它们会把不同接口判成重复（实测 mobwsa.ximalaya.com 的 tabs/v2 与
 * recommendContentV1 共享 mobile/playpage 两词，但那是两个不同接口）。
 */
const NOISE = new Set(["mobile", "playpage", "play", "page", "tabs", "list", "index", "home",
  "main", "get", "query", "info", "detail", "config", "user", "v1", "v2", "v3", "api"]);

export function sameTarget(a, b) {
  if (!sameHost(a.domains, b.domains)) return false;
  const shared = [...a.pathTokens].filter((t) => b.pathTokens.has(t));
  const distinctive = shared.filter((t) => !NOISE.has(t));
  if (distinctive.length >= 2) return true;
  // 短路径退化处理：路径里只有 ≤1 个词元时（如 `ad.12306.cn/ad/ser/getAdList`
  // 去掉域名后只剩 {getadlist}），「≥2 个共同词元」永远不成立 —— 于是
  // `sameTarget` 恒 false，两条防线**同时失明**：validate 的 checkRewriteDuplicates
  // 与 vendor-rules 合并期的 excludedByStandalone 都漏掉它。
  // 实测后果：`ad.12306.cn/ad/ser/getAdList` 同时被 AdsBlock 的
  // `script-analyze-echo-response` 与 kelee 的 `jsonjq-response-body` 命中，
  // 同一个 body 被两套逻辑处理（或后者永不执行）。
  // 故当任一侧词元很少时，退化为「域名相同 + 路径串前缀一致」：
  // 路径短到没词元可判，就只能靠字面比对，这比放行安全。
  const fewTokens = a.pathTokens.size <= 1 || b.pathTokens.size <= 1;
  if (fewTokens) {
    const pa = [...a.pathTokens].join("/");
    const pb = [...b.pathTokens].join("/");
    if (pa && pa === pb) return true;
    // 一侧无词元、另一侧也无可比词元时，域名相同即视为同一目标（宁可多报，不可漏防）
    if (!pa && !pb) return true;
  }
  return false;
}
