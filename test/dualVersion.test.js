'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeImposition } = require('../src/imposition');

// 8 页、每帖 2 张、左装订、短边翻转的经典布局：
// 第 1 张：正面 [8, 1]、背面 [2, 7]；第 2 张：正面 [6, 3]、背面 [4, 5]
const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };
const DV = { copiesA: 1000, copiesB: 500, changedPages: [1] };

test('未启用双版本共版：响应不含 dualVersion 字段（原响应完全不变）', () => {
  // 比较时剔除生成时间戳（两次调用必然不同）
  const strip = (r) => JSON.parse(JSON.stringify(r, (k, v) => (k === 'generatedAt' ? undefined : v)));
  const baseline = computeImposition({ ...BASE });
  assert.equal(baseline.dualVersion, undefined);
  const explicitOff = computeImposition({ ...BASE, dualVersion: false });
  assert.equal(explicitOff.dualVersion, undefined);
  const nullOff = computeImposition({ ...BASE, dualVersion: null });
  assert.equal(nullOff.dualVersion, undefined);
  const disabledObj = computeImposition({ ...BASE, dualVersion: { enabled: false, ...DV } });
  assert.equal(disabledObj.dualVersion, undefined);
  // 未启用时拼版结果与基线逐字段一致
  assert.deepEqual(strip(explicitOff), strip(baseline));
  assert.deepEqual(strip(nullOff), strip(baseline));
  assert.deepEqual(strip(disabledObj), strip(baseline));
});

test('单页改动：仅含第 1 页的面拆版，其余面共用；印次 = 各自份数', () => {
  const r = computeImposition({ ...BASE, dualVersion: DV });
  const dv = r.dualVersion;
  assert.equal(dv.enabled, true);
  assert.equal(dv.copiesA, 1000);
  assert.equal(dv.copiesB, 500);
  assert.deepEqual(dv.changedPages, [1]);
  assert.equal(dv.changedPageCount, 1);
  assert.equal(dv.sheets.length, 2);

  // 第 1 张正面 [8, 1] 含改动页 1 -> 拆 A、B 两块版
  const s1 = dv.sheets[0];
  assert.equal(s1.signature, 1);
  assert.equal(s1.sheet, 1);
  assert.deepEqual(s1.front.pages, [8, 1]);
  assert.equal(s1.front.changed, true);
  assert.deepEqual(s1.front.changedPages, [1]);
  assert.deepEqual(s1.front.plates, [
    { version: 'A', impressions: 1000 },
    { version: 'B', impressions: 500 },
  ]);
  // 第 1 张背面 [2, 7] 无改动页 -> 共用一块版，印次 A+B（同张纸正背面独立判定）
  assert.deepEqual(s1.back.pages, [2, 7]);
  assert.equal(s1.back.changed, false);
  assert.deepEqual(s1.back.changedPages, []);
  assert.deepEqual(s1.back.plates, [{ version: 'A+B', impressions: 1500 }]);
  // 第 2 张正背面均无改动页
  assert.equal(dv.sheets[1].front.changed, false);
  assert.equal(dv.sheets[1].back.changed, false);

  const t = dv.totals;
  assert.equal(t.sheetCount, 2);
  assert.equal(t.sideCount, 4);
  assert.equal(t.splitSides, 1);
  assert.equal(t.sharedSides, 3);
  assert.equal(t.sharedPlates, 3);
  assert.equal(t.versionPlates, 2);
  assert.equal(t.plateCount, 5);
  assert.equal(t.impressionsShared, 4500); // 3 × (1000 + 500)
  assert.equal(t.impressionsA, 1000); // 1 × 1000
  assert.equal(t.impressionsB, 500); // 1 × 500
  assert.equal(t.totalImpressions, 6000); // 4 × 1500
});

test('区间与单页混合：自动去重并升序；逐面判定互不影响', () => {
  const r = computeImposition({
    ...BASE,
    dualVersion: { copiesA: 10, copiesB: 4, changedPages: [7, '5-6', '3', '2-3', 6] },
  });
  const dv = r.dualVersion;
  assert.deepEqual(dv.changedPages, [2, 3, 5, 6, 7]);
  assert.equal(dv.changedPageCount, 5);
  // 第 1 张：正面 [8, 1] 共用；背面 [2, 7] 拆版（改动页 2、7）
  assert.equal(dv.sheets[0].front.changed, false);
  assert.deepEqual(dv.sheets[0].back.changedPages, [2, 7]);
  // 第 2 张：正面 [6, 3] 拆版（改动页 6、3）；背面 [4, 5] 拆版（改动页 5）
  assert.deepEqual(dv.sheets[1].front.changedPages, [6, 3]);
  assert.deepEqual(dv.sheets[1].back.changedPages, [5]);
  const t = dv.totals;
  assert.equal(t.splitSides, 3);
  assert.equal(t.sharedSides, 1);
  assert.equal(t.plateCount, 1 + 3 * 2);
  assert.equal(t.impressionsShared, 14); // 1 × (10 + 4)
  assert.equal(t.impressionsA, 30); // 3 × 10
  assert.equal(t.impressionsB, 12); // 3 × 4
  assert.equal(t.totalImpressions, 56); // 4 × 14
});

test('改动页码支持整体字符串与单个数字输入（"3, 5-7" 与 3）', () => {
  const byString = computeImposition({
    ...BASE,
    dualVersion: { copiesA: 1, copiesB: 1, changedPages: '3, 5-7' },
  });
  assert.deepEqual(byString.dualVersion.changedPages, [3, 5, 6, 7]);
  const byNumber = computeImposition({
    ...BASE,
    dualVersion: { copiesA: 1, copiesB: 1, changedPages: 3 },
  });
  assert.deepEqual(byNumber.dualVersion.changedPages, [3]);
  // 波浪线 / 全角分隔符同样可用
  const byTilde = computeImposition({
    ...BASE,
    dualVersion: { copiesA: 1, copiesB: 1, changedPages: ['5~7', '1～1'] },
  });
  assert.deepEqual(byTilde.dualVersion.changedPages, [1, 5, 6, 7]);
  // 区间两侧允许空白（"5 - 7"），空白分隔的单页同样可用
  const withSpaces = computeImposition({
    ...BASE,
    dualVersion: { copiesA: 1, copiesB: 1, changedPages: '1 2, 5 - 7' },
  });
  assert.deepEqual(withSpaces.dualVersion.changedPages, [1, 2, 5, 6, 7]);
});

test('补白的空白页不算改动页：全空白面共用印版', () => {
  // 10 页、每帖 2 张 -> 第 2 帖第 2 张全部为空白页
  const r = computeImposition({
    totalPages: 10,
    sheetsPerSignature: 2,
    binding: 'left',
    flip: 'short',
    dualVersion: { copiesA: 100, copiesB: 20, changedPages: [9] },
  });
  const dv = r.dualVersion;
  assert.equal(dv.sheets.length, 4);
  // 第 2 帖第 1 张正面 [空白, 9] 含改动页 9 -> 拆版
  const sig2sheet1 = dv.sheets[2];
  assert.equal(sig2sheet1.signature, 2);
  assert.equal(sig2sheet1.sheet, 1);
  assert.deepEqual(sig2sheet1.front.pages, [null, 9]);
  assert.equal(sig2sheet1.front.changed, true);
  assert.deepEqual(sig2sheet1.front.changedPages, [9]);
  // 第 2 帖第 2 张全部空白 -> 两面均共用
  const sig2sheet2 = dv.sheets[3];
  assert.deepEqual(sig2sheet2.front.pages, [null, null]);
  assert.equal(sig2sheet2.front.changed, false);
  assert.equal(sig2sheet2.back.changed, false);
  assert.equal(dv.totals.splitSides, 1);
  assert.equal(dv.totals.sharedSides, 7);
});

test('同张纸正背面独立判定：正面拆版、背面可共用', () => {
  // 改动页 8 在第 1 张正面左页位；同张背面为 [2, 7]，不含改动页
  const r = computeImposition({ ...BASE, dualVersion: { copiesA: 5, copiesB: 2, changedPages: [8] } });
  const s1 = r.dualVersion.sheets[0];
  assert.equal(s1.front.changed, true);
  assert.equal(s1.back.changed, false);
  assert.deepEqual(s1.back.plates, [{ version: 'A+B', impressions: 7 }]);
});

test('与印刷备料 / 试印核验等其他可选模块同时启用互不干扰', () => {
  const r = computeImposition({
    ...BASE,
    dualVersion: DV,
    materialPrep: { copies: 1000, makereadySheets: 10, processWasteRate: 0.03, sheetsPerPack: 500 },
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
    ],
  });
  assert.equal(r.dualVersion.enabled, true);
  assert.equal(r.dualVersion.totals.plateCount, 5);
  assert.equal(r.materialPrep.enabled, true);
  assert.equal(r.verification.enabled, true);
  // 拼版页位不受双版本模块影响
  const plain = computeImposition({ ...BASE });
  assert.deepEqual(
    JSON.parse(JSON.stringify(r.signatures)),
    JSON.parse(JSON.stringify(plain.signatures))
  );
});

test('非法参数返回明确错误', () => {
  // 非对象
  assert.throws(() => computeImposition({ ...BASE, dualVersion: 5 }), /必须为对象/);
  // 开关非布尔
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { enabled: 'yes', ...DV } }),
    /开关 enabled 必须为布尔值/
  );
  // 份数非法
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, copiesA: 0 } }),
    /copiesA/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, copiesB: 1.5 } }),
    /copiesB/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { copiesB: 500, changedPages: [1] } }),
    /copiesA/
  );
  // 改动页码为空 / 非数组非字符串
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: [] } }),
    /至少填写 1 个/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: true } }),
    /changedPages/
  );
  // 页码越界（0 与超过总页数）
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: [0] } }),
    /≥ 1/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: [9] } }),
    /超出范围（1 ~ 8）/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: ['6-9'] } }),
    /超出范围（1 ~ 8）/
  );
  // 区间起点大于终点 / 无法识别的条目
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: ['7-5'] } }),
    /起点不能大于终点/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: ['abc'] } }),
    /无法识别/
  );
  assert.throws(
    () => computeImposition({ ...BASE, dualVersion: { ...DV, changedPages: [1.5] } }),
    /无法识别/
  );
});
