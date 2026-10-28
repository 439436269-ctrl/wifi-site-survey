#!/usr/bin/env node
/**
 * 原子④：多点位汇总（纯分析，不碰网络）
 *
 * 采集阶段只回答「这个位置怎么样」；这个原子回答**位置之间**的问题：
 *   - 每个位置该连哪个 SSID（按实测吞吐排，不按信号排）
 *   - 哪个 AP 只覆盖一点点（覆盖窄 = 装错地方）
 *   - 有哪些 AP 挤在同一信道（互扰）
 *   - 改造前后差多少（两组记录对比）
 *
 * 输入：run-position.mjs 产出的记录 JSON（{id, place, ts, signals[], measures[]}）
 *      也可以直接吃 server/data/positions 那种目录
 *
 * 用法：
 *   node aggregate.mjs --dir ../server/data/positions
 *   node aggregate.mjs a.json b.json c.json
 *   node aggregate.mjs --dir after --compare before      # 前后对比
 *   node aggregate.mjs --dir records --json out.json     # 同时出机器可读
 */
import fs from 'node:fs';
import path from 'node:path';

/* ---------------- 参数 ---------------- */

function parseArgs(argv = process.argv.slice(2)) {
  const out = { files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else out.files.push(a);
  }
  return out;
}

/* ---------------- 读记录 ---------------- */

const isRecord = (o) => o && typeof o === 'object' && typeof o.place === 'string' && (Array.isArray(o.signals) || Array.isArray(o.measures));

function readRecords(target) {
  const files = [];
  const walk = (p) => {
    if (!fs.existsSync(p)) return;
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const f of fs.readdirSync(p)) {
        if (f.endsWith('.json') && !f.startsWith('_')) walk(path.join(p, f));
      }
    } else if (p.endsWith('.json')) files.push(p);
  };
  for (const t of [].concat(target)) walk(t);

  const records = [];
  const skipped = [];
  for (const f of files) {
    try {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (isRecord(obj)) {
        records.push({ ...obj, _file: path.basename(f) });
      } else if (obj.kind === 'ap-signals' || obj.kind === 'ssid-measure') {
        skipped.push(`${path.basename(f)}（原子输出，需要先用 run-position 合成记录）`);
      } else {
        skipped.push(`${path.basename(f)}（不认识的结构）`);
      }
    } catch (e) {
      skipped.push(`${path.basename(f)}（JSON 解析失败：${e.message}）`);
    }
  }
  return { records: sortByTime(records), skipped, files: files.length };
}

const tsOf = (r) => {
  const n = new Date(r.ts).getTime();
  return Number.isFinite(n) ? n : 0;
};
const sortByTime = (rs) => [...rs].sort((a, b) => tsOf(a) - tsOf(b));

/** 同一点位可能有多次测量（改造前/后）。默认留最新一条，避免矩阵里出现两行同名 */
function dedupeByPlace(records, keepAll = false) {
  if (keepAll) return { records, dropped: [] };
  const latest = new Map();
  const dropped = [];
  const hasSpeed = (r) => (r.measures ?? []).some((m) => m.state !== 'fail' && Number(m.mbps) > 0);
  const better = (a, b) => {
    // 有吞吐的记录信息量更大：以「仅扫信号」的记录为准，会把整个点位降级成没有速度
    if (hasSpeed(a) !== hasSpeed(b)) return hasSpeed(a);
    return tsOf(a) >= tsOf(b);
  };
  for (const r of records) {
    const prev = latest.get(r.place);
    if (!prev) { latest.set(r.place, r); continue; }
    if (better(r, prev)) {
      dropped.push({ place: r.place, ts: prev.ts, kept: r.ts });
      latest.set(r.place, r);
    } else {
      dropped.push({ place: r.place, ts: r.ts, kept: prev.ts });
    }
  }
  return { records: sortByTime([...latest.values()]), dropped };
}

const bandKind = (b) => {
  const s = String(b || '');
  if (s.includes('5')) return '5G';
  if (s.includes('2.4')) return '2.4G';
  return s || '?';
};

/* ---------------- 分析 ---------------- */

/** 每个位置的主指标 */
function summarize(r) {
  const measures = (r.measures ?? []).filter((m) => m.state !== 'fail' && Number(m.mbps) > 0);
  const by = (k) => measures.filter((m) => bandKind(m.band) === k).sort((a, b) => b.mbps - a.mbps);
  const s5 = by('5G'), s24 = by('2.4G');
  const signals = r.signals ?? [];
  const strongest = signals.reduce((acc, a) => (acc === null || a.median > acc.median ? a : acc), null);
  return {
    place: r.place,
    ts: r.ts,
    kind: measures.length ? 'speed' : signals.length ? 'signal' : 'empty',
    best5g: s5[0] ?? null,
    best24: s24[0] ?? null,
    strongest,
    gwMs: (s5[0] ?? s24[0] ?? {}).gwMs ?? null,
  };
}

/** 信号矩阵：行=位置，列=AP（按 AP+频段+信道 定义一列） */
function matrix(records) {
  const cols = new Map();
  for (const r of records) {
    for (const a of r.signals ?? []) {
      const key = `${a.ap}|${a.band}|${a.channel}`;
      if (!cols.has(key)) cols.set(key, { ap: a.ap, band: a.band, channel: a.channel, bssid: a.bssid });
    }
  }
  const columns = [...cols.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((x, y) => `${x.ap}${bandKind(x.band)}${x.channel}`.localeCompare(`${y.ap}${bandKind(y.band)}${y.channel}`));

  const rows = records.map((r) => {
    const cells = {};
    for (const a of r.signals ?? []) cells[`${a.ap}|${a.band}|${a.channel}`] = a.median;
    return { place: r.place, cells };
  });
  return { columns, rows };
}

/** 同信道冲突：同一频段同一信道上有多台不同 BSSID */
function channelConflicts(records) {
  const seen = new Map();
  for (const r of records) {
    for (const a of r.signals ?? []) {
      const k = `${bandKind(a.band)}|ch${a.channel}`;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k).add(a.ap);
    }
  }
  return [...seen.entries()]
    .filter(([, aps]) => aps.size >= 2)
    .map(([k, aps]) => ({ channel: k, aps: [...aps] }));
}

/** 每个 AP 的覆盖：在几个点位可见、最强最弱各多少 */
function coverage(records) {
  const byAp = new Map();
  for (const r of records) {
    for (const a of r.signals ?? []) {
      const k = `${a.ap}（${bandKind(a.band)} ch${a.channel}）`;
      if (!byAp.has(k)) byAp.set(k, []);
      byAp.get(k).push({ place: r.place, median: a.median });
    }
  }
  return [...byAp.entries()]
    .map(([ap, list]) => {
      const hi = list.reduce((x, y) => (y.median > x.median ? y : x));
      const lo = list.reduce((x, y) => (y.median < x.median ? y : x));
      return { ap, places: list.length, hi, lo, drop: hi.median - lo.median, list };
    })
    .sort((a, b) => b.drop - a.drop);
}

/* ---------------- 输出 ---------------- */

function renderSummary(recs) {
  const out = [];
  out.push('## 一、每个位置的主指标', '');
  out.push('| 位置 | 最佳 5G | 最佳 2.4G | 该连哪个 | 备用 2.4G | 网关 |');
  out.push('|---|---|---|---|---|---|');
  for (const r of recs) {
    const s = summarize(r);
    // 不能无脑「5G 优先」：5G 只剩十几兆、2.4G 反而更快时，该推 2.4G
    const g5 = s.best5g, g24 = s.best24;
    const prefer24 = g5 && g24 && g5.mbps < 50 && g24.mbps > g5.mbps;
    const pick = prefer24 ? g24 : (g5 ?? g24);
    const weak = pick && pick.mbps < 50;
    const primary = pick
      ? `\`${pick.ssid}\` **${pick.mbps}**${weak ? ' ⚠️ 偏弱' : ''}`
      : '（没测吞吐）';
    const backup = prefer24 ? (g5 ? `${g5.mbps}（5G 反而慢）` : '—') : (g5 && g24 ? `${g24.mbps}` : '—');
    const b5 = s.best5g ? `${s.best5g.mbps}` : '—';
    const b24 = s.best24 ? `${s.best24.mbps}` : '—';
    const gw = s.gwMs != null ? `${s.gwMs} ms` : '—';
    out.push(`| ${r.place} | ${b5} | ${b24} | ${primary} | ${backup} | ${gw} |`);
  }
  out.push('');
  return out.join('\n');
}

function renderMatrix(records) {
  const { columns, rows } = matrix(records);
  if (!columns.length) return '';
  const out = [];
  out.push('## 二、信号矩阵（%）', '');
  out.push('| 位置 | ' + columns.map((c) => `${c.ap}<br>${bandKind(c.band)} ch${c.channel}`).join(' | ') + ' |');
  out.push('|---|' + columns.map(() => '---').join('|') + '|');
  for (const row of rows) {
    out.push(`| ${row.place} | ` + columns.map((c) => (row.cells[c.key] != null ? `**${row.cells[c.key]}**` : '·')).join(' | ') + ' |');
  }
  out.push('', '> `·` = 该位置扫不到这台 AP（不是 0，是没信号）', '');
  return out.join('\n');
}

function renderConflicts(records) {
  const c = channelConflicts(records);
  const out = ['## 三、同信道冲突', ''];
  if (!c.length) {
    out.push('没有发现两台以上的 AP 挤在同一信道。', '');
    return out.join('\n');
  }
  out.push('| 信道 | 挤在一起的 AP | 判断 |');
  out.push('|---|---|---|');
  for (const x of c) {
    out.push(`| ${x.channel} | ${x.aps.join(' / ')} | **互扰**：同频会互等空口，建议至少错开一台 |`);
  }
  out.push('');
  return out.join('\n');
}

/** 同一台设备如果有两个名字（如 AP-1 / AP-1-5G），矩阵里会分裂成两列 */
function aliasWarnings(records) {
  const names = new Set();
  for (const r of records) for (const a of r.signals ?? []) names.add(a.ap);
  const out = [];
  const list = [...names];
  for (const a of list) {
    for (const b of list) {
      if (a !== b && b.startsWith(a)) out.push(`\`${a}\` 与 \`${b}\` 可能是同一台设备（命名不统一，矩阵里会分成两列）`);
    }
  }
  return [...new Set(out)];
}

function renderCoverage(records) {
  const cov = coverage(records);
  const out = ['## 四、每台 AP 的覆盖范围', '', '| AP | 可见点位 | 最强 | 最弱 | 落差 | 判断 |', '|---|---|---|---|---|---|'];
  for (const c of cov) {
    const narrow = c.places <= Math.max(1, Math.round(records.length / 3));
    const bigDrop = c.drop >= 50;
    const judge = narrow ? '覆盖窄，可能装错位置' : bigDrop ? '落差大，穿墙/距离损耗明显' : '覆盖正常';
    out.push(`| ${c.ap} | ${c.places}/${records.length} | ${c.hi.median}%（${c.hi.place}） | ${c.lo.median}%（${c.lo.place}） | **${c.drop}** | ${judge} |`);
  }
  out.push('');
  return out.join('\n');
}

/** 改造前后对比：按 place 配对 */
function renderCompare(before, after) {
  const key = (r) => r.place;
  const bmap = new Map(before.map((r) => [key(r), r]));
  const out = ['## 五、改造前后对比', ''];
  const pairs = after.filter((r) => bmap.has(key(r)));
  if (!pairs.length) {
    out.push('两组记录里没有同名点位，无法配对。', '');
    return out.join('\n');
  }
  out.push('| 位置 | 前 · 最佳 5G | 后 · 最佳 5G | 变化 | 前 · 2.4G | 后 · 2.4G |');
  out.push('|---|---|---|---|---|---|');
  for (const a of pairs) {
    const b = bmap.get(key(a));
    const sb = summarize(b), sa = summarize(a);
    const f = (x) => (x ? x.mbps : '—');
    const b5 = sb.best5g?.mbps ?? null, a5 = sa.best5g?.mbps ?? null;
    const delta = b5 && a5 ? (a5 / b5 >= 1 ? `**×${(a5 / b5).toFixed(1)}**` : `×${(a5 / b5).toFixed(2)}`) : '—';
    out.push(`| ${a.place} | ${f(sb.best5g)} | ${f(sa.best5g)} | ${delta} | ${f(sb.best24)} | ${f(sa.best24)} |`);
  }
  out.push('');
  const onlyAfter = after.filter((r) => !bmap.has(key(r)));
  if (onlyAfter.length) {
    out.push(`> 只在「后」组出现（改造前没测）：${onlyAfter.map((r) => r.place).join('、')}`, '');
  }
  return out.join('\n');
}

/* ---------------- 主流程 ---------------- */

function main() {
  const args = parseArgs();
  const inputs = args.dir ? [].concat(args.dir).concat(args.files ?? []) : (args.files ?? []);
  if (!inputs.length) {
    console.error('用法：node aggregate.mjs --dir <记录目录> [--compare <另一组目录>] [--json <out.json>]');
    process.exit(1);
  }

  let main = readRecords(inputs);
  if (main.skipped.length) {
    console.error(`[跳过 ${main.skipped.length} 个文件]`);
    for (const s of main.skipped) console.error('  ' + s);
  }
  if (!main.records.length) {
    console.error('没有可用的记录。记录需要有 {place, ts, signals[], measures[]} 结构（run-position.mjs 会产出）。');
    process.exit(1);
  }

  const dd = dedupeByPlace(main.records, Boolean(args.all));
  if (dd.dropped.length) {
    console.error(`[同点位多条记录] 保留最新一条，忽略 ${dd.dropped.length} 条（要全看加 --all）`);
    for (const d of dd.dropped) console.error(`  ${d.place}：忽略 ${d.ts}`);
  }
  main = { ...main, records: dd.records };
  const aliases = aliasWarnings(main.records);

  const parts = [
    '# WiFi 多点位汇总',
    '',
    `生成时间：${new Date().toLocaleString('zh-CN')}　记录数：${main.records.length}`,
    '',
    renderSummary(main.records),
    renderMatrix(main.records),
    renderConflicts(main.records),
    renderCoverage(main.records),
  ];

  if (aliases.length) {
    parts.push(['## 附：命名不一致', '', ...aliases.map((x) => `- ${x}`), ''].join('\n'));
  }

  if (args.compare) {
    const before = readRecords([].concat(args.compare));
    if (before.records.length) parts.push(renderCompare(before.records, main.records));
    else console.error('[对比] 那一组没有可用记录');
  }

  const md = parts.filter(Boolean).join('\n');
  process.stdout.write(md + '\n');

  if (args.json && args.json !== true) {
    const payload = {
      generatedAt: new Date().toISOString(),
      positions: main.records.map(summarize).map((s) => ({
        place: s.place, kind: s.kind,
        best5g: s.best5g ? { ssid: s.best5g.ssid, mbps: s.best5g.mbps } : null,
        best24: s.best24 ? { ssid: s.best24.ssid, mbps: s.best24.mbps } : null,
      })),
      matrix: matrix(main.records),
      conflicts: channelConflicts(main.records),
      coverage: coverage(main.records).map((c) => ({ ap: c.ap, places: c.places, drop: c.drop, judge: c.places <= 2 ? 'narrow' : c.drop >= 50 ? 'drop' : 'ok' })),
    };
    fs.writeFileSync(args.json, JSON.stringify(payload, null, 2), 'utf8');
    console.error(`\nJSON 已写入 ${args.json}`);
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main();
export { summarize, matrix, channelConflicts, coverage, renderCompare, readRecords };
