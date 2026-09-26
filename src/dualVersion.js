'use strict';

/**
 * 双版本共版印刷清单（dual-version shared-plate printing）。
 *
 * 同一本书印 A、B 两个版本：B 版仅相对 A 版改动了少量真实页码，其余页面
 * 内容完全一致。为节省印版，沿用当前拼版结果（分帖、补白、装订与翻转后的
 * 页位全部不变），逐张逐面判定该面是否含有改动页：
 *
 * - 无改动页的面：A、B 两版**共用一块印版**，印次 = A 版份数 + B 版份数；
 * - 含改动页的面：拆成 **A、B 两块印版**，各按自身份数印刷
 *   （A 版印 copiesA 次、B 版印 copiesB 次）；
 * - 同一张纸的正、背面**独立判定**（正面含改动页不代表背面也拆版）；
 * - 补白的空白页不是真实页码，永远不算改动页。
 *
 * 输入（API 字段 dualVersion，缺省 / null / false / { enabled: false } 时
 * 整个模块不启用，原响应完全不变）：
 * - copiesA        A 版成品份数（≥1 的整数）；
 * - copiesB        B 版成品份数（≥1 的整数）；
 * - changedPages   B 版相对 A 版改动的真实页码（至少 1 个），支持：
 *   - 单页：数字或纯数字字符串（如 3、"3"）；
 *   - 区间：字符串 "5-8"（起止页均含，分隔符支持 - ~ ～ – —）；
 *   - 整体也可以是逗号 / 空白分隔的字符串（如 "3, 5-8, 9"）；
 *   自动去重并升序排列；每个页码必须在 1 ~ totalPages 范围内。
 *
 * 输出（顶层 dualVersion 段）：
 * - sheets[]：逐张逐面的页码、是否含改动页、本面改动页与印版归属
 *   （共用版 version 为 "A+B"，拆版面为 "A" / "B" 两块，各带印次）；
 * - totals：面数 / 共用面 / 拆版面 / 印版数（共用版 + 版本版）与
 *   印次汇总（共用版印次、A 版印次、B 版印次、总印次）。
 */

const MAX_COPIES = 100000000; // 成品份数上限 1 亿（与印刷备料一致）

/**
 * 解析整数参数：接受整数或纯数字字符串，布尔 / null / 空串等返回 NaN。
 * 与拼版核心 / 备料模块的 toInteger 保持一致语义。
 */
function toInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : NaN;
}

/** 区间分隔符：半角连字符、波浪线（半 / 全角）、短横线（en / em dash）。 */
const RANGE_SEPARATORS = ['-', '~', '～', '–', '—'];

/**
 * 解析改动页码列表：支持单页与区间，去重并升序排列。
 * 此处只校验格式（整数、区间起止合法）；页码范围（1 ~ totalPages）由
 * attachDualVersion 结合拼版结果校验。
 *
 * 字符串形式先按逗号 / 顿号 / 分号切成条目：含区间分隔符的条目整体按区间解析
 * （允许「5 - 7」这类带空白的写法），其余条目再按空白拆成单页。
 *
 * @param {Array| string | number} raw 页码数组，或逗号 / 空白分隔的字符串，或单个数字
 * @returns {Array<number>} 去重升序后的真实页码（至少 1 个）
 */
function parseChangedPages(raw) {
  let tokens;
  if (Array.isArray(raw)) {
    tokens = raw.slice();
  } else if (typeof raw === 'string') {
    tokens = [];
    raw.split(/[,，、;；]+/).forEach((part) => {
      const text = part.trim();
      if (!text) return;
      // 含区间分隔符的条目整体按区间处理（允许「5 - 7」带空白），否则按空白拆单页
      if (RANGE_SEPARATORS.some((s) => text.includes(s))) {
        tokens.push(text);
      } else {
        tokens.push(...text.split(/\s+/).filter(Boolean));
      }
    });
  } else if (typeof raw === 'number') {
    tokens = [raw];
  } else {
    throw new Error('改动页码 changedPages 必须为数组或逗号分隔的字符串（支持单页与区间，如 [3, "5-8"] 或 "3, 5-8"）');
  }
  if (tokens.length === 0) {
    throw new Error('改动页码 changedPages 至少填写 1 个（支持单页与区间，如 3 或 "5-8"）');
  }

  const pages = new Set();
  tokens.forEach((token) => {
    // 单页：整数或纯数字字符串
    const single = typeof token === 'number'
      ? token
      : (typeof token === 'string' && /^\d+$/.test(token.trim()) ? Number(token.trim()) : NaN);
    if (Number.isInteger(single)) {
      if (single < 1) {
        throw new Error(`改动页码必须为 ≥ 1 的整数（收到 ${JSON.stringify(token)}）`);
      }
      pages.add(single);
      return;
    }
    // 区间：字符串 "起-止"（起止页均含）
    if (typeof token === 'string') {
      const text = token.trim();
      const sep = RANGE_SEPARATORS.find((s) => text.includes(s));
      if (sep) {
        const parts = text.split(sep).map((p) => p.trim());
        if (parts.length === 2 && parts.every((p) => /^\d+$/.test(p))) {
          const from = Number(parts[0]);
          const to = Number(parts[1]);
          if (from > to) {
            throw new Error(`改动页码区间起点不能大于终点（收到「${text}」）`);
          }
          for (let p = from; p <= to; p++) pages.add(p);
          return;
        }
      }
    }
    throw new Error(`改动页码含有无法识别的条目：${JSON.stringify(token)}（支持单页如 3，区间如 "5-8"）`);
  });

  return [...pages].sort((a, b) => a - b);
}

/**
 * 解析并校验双版本共版输入。
 * @returns {{enabled: false} | {enabled: true, copiesA: number, copiesB: number, changedPages: Array<number>}}
 */
function parseDualVersionInput(input) {
  const raw = input && input.dualVersion;
  if (raw === undefined || raw === null || raw === false) {
    return { enabled: false };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('双版本共版参数 dualVersion 必须为对象（含 copiesA / copiesB / changedPages）');
  }
  if (raw.enabled === false) {
    return { enabled: false };
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new Error('双版本共版开关 enabled 必须为布尔值（true / false）');
  }

  const copiesA = toInteger(raw.copiesA);
  if (!Number.isInteger(copiesA) || copiesA < 1 || copiesA > MAX_COPIES) {
    throw new Error(`A 版成品份数 copiesA 必须为 1 ~ ${MAX_COPIES.toLocaleString('en-US')} 的整数`);
  }
  const copiesB = toInteger(raw.copiesB);
  if (!Number.isInteger(copiesB) || copiesB < 1 || copiesB > MAX_COPIES) {
    throw new Error(`B 版成品份数 copiesB 必须为 1 ~ ${MAX_COPIES.toLocaleString('en-US')} 的整数`);
  }
  const changedPages = parseChangedPages(raw.changedPages);

  return { enabled: true, copiesA, copiesB, changedPages };
}

/**
 * 依据拼版结果逐张逐面判定印版归属并附加汇总。
 * 仅在 parseDualVersionInput 返回 enabled 时调用；否则不写入任何字段。
 *
 * @param {object} result 拼版计算结果（读取各帖各张正背面页位与 totalPages）
 * @param {{enabled:true, copiesA:number, copiesB:number, changedPages:Array<number>}} dv
 * @returns {object} 双版本共版清单（dualVersion 段）
 */
function attachDualVersion(result, dv) {
  if (!dv.enabled) return undefined;
  const { copiesA, copiesB, changedPages } = dv;
  const totalPages = result.input.totalPages;

  // 页码范围校验（需要已校验的 totalPages，故在 attach 阶段进行）
  changedPages.forEach((p) => {
    if (p > totalPages) {
      throw new Error(`改动页码 ${p} 超出范围（1 ~ ${totalPages}）`);
    }
  });

  const changedSet = new Set(changedPages);
  const sharedImpressions = copiesA + copiesB; // 共用版印次 = A + B

  const sheets = [];
  let sharedSides = 0;
  let splitSides = 0;
  result.signatures.forEach((sig) => {
    sig.sheets.forEach((sheet) => {
      const row = { signature: sig.index, sheet: sheet.index };
      ['front', 'back'].forEach((sideName) => {
        const side = sheet[sideName];
        // 本面左、右页位的真实页码（补白页为 null，永远不算改动页）
        const pages = [side.left, side.right].map((slot) => (slot.blank ? null : slot.page));
        const sideChangedPages = pages.filter((p) => p !== null && changedSet.has(p));
        const changed = sideChangedPages.length > 0;
        if (changed) {
          splitSides += 1;
        } else {
          sharedSides += 1;
        }
        row[sideName] = {
          pages,
          changed,
          changedPages: sideChangedPages,
          plates: changed
            ? [
                { version: 'A', impressions: copiesA },
                { version: 'B', impressions: copiesB },
              ]
            : [{ version: 'A+B', impressions: sharedImpressions }],
        };
      });
      sheets.push(row);
    });
  });

  const sideCount = sheets.length * 2;
  return {
    enabled: true,
    copiesA,
    copiesB,
    changedPages: changedPages.slice(),
    changedPageCount: changedPages.length,
    rule: '无改动页的面共用 1 块印版（印次 = A 版份数 + B 版份数）；含改动页的面拆成 A、B 两块印版（各按自身份数印刷）；同张纸正背面独立判定',
    sheets,
    totals: {
      sheetCount: sheets.length,
      sideCount,
      sharedSides,
      splitSides,
      sharedPlates: sharedSides,
      versionPlates: splitSides * 2,
      plateCount: sharedSides + splitSides * 2,
      impressionsShared: sharedSides * sharedImpressions,
      impressionsA: splitSides * copiesA,
      impressionsB: splitSides * copiesB,
      totalImpressions: sideCount * sharedImpressions,
    },
  };
}

module.exports = {
  parseDualVersionInput,
  attachDualVersion,
};
