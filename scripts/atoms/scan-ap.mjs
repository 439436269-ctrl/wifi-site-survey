#!/usr/bin/env node
// 原子①：扫描各 AP 信号
//
// 断开 → 连扫 N 次 → 每个 BSSID 取中位 → 输出 JSON
// 为什么必须断开：连着时网卡只在当前信道工作，其它信道读的是缓存。
// 实测同一位置：连着扫 AP-1 5G = 45%，断开扫 = 94%。
//
// 用法：
//   node atoms/scan-ap.mjs                       # 打印 JSON
//   node atoms/scan-ap.mjs --out scan.json       # 写文件
//   node atoms/scan-ap.mjs --rounds 3 --wait 4
//   node atoms/scan-ap.mjs --keep-connected      # 扫完自动连回原 SSID

import fs from 'node:fs';
import { OWN_PREFIX, apName, parseArgs } from '../lib/config.mjs';
import { disconnect, listNetworks, connect, currentSsid, sleep } from '../lib/wifi.mjs';

const args = parseArgs();
const rounds = Number(args.rounds ?? 3);
const waitSec = Number(args.wait ?? 4);

const previous = currentSsid();

disconnect();
await sleep(5000);

const acc = new Map();
const meta = new Map();
let seen = 0;                       // 一共扫到多少个 BSSID（不论是不是自家的）
let skippedForeign = 0;

for (let r = 1; r <= rounds; r++) {
  for (const n of listNetworks()) {
    seen++;
    // 只保留自家 AP：邻居的 BSSID 会把「同信道冲突」这类判断带偏
    if (OWN_PREFIX.length && !OWN_PREFIX.some((p) => n.bssid.startsWith(p))) { skippedForeign++; continue; }
    const key = `${n.bssid}`;
    if (!acc.has(key)) { acc.set(key, []); meta.set(key, n); }
    if (n.signal > 0) acc.get(key).push(n.signal);
  }
  if (r < rounds) await sleep(waitSec * 1000);
}

// 静默返回 0 条最危险：读者会以为「这里没有 WiFi」，其实是前缀表没过
if (!acc.size) {
  const hint = OWN_PREFIX.length
    ? `扫到 ${seen} 个 BSSID，但没有任何一个匹配 lib/config.mjs 的 AP_NAMES（前缀 ${OWN_PREFIX.join(' / ')}）`
    : `扫到 ${seen} 个 BSSID，但 OWN_PREFIX 为空`;
  console.error(`[scan-ap] ⚠️  0 个自家 AP —— ${hint}`);
  console.error('[scan-ap]    换到新环境时，先把 lib/config.mjs 的 AP_NAMES 改成自己的 MAC 前缀；');
  console.error('[scan-ap]    前缀从 `netsh wlan show networks mode=bssid` 的输出里抄前 8 位。');
  if (skippedForeign) console.error(`[scan-ap]    本次有 ${skippedForeign} 个 BSSID 因前缀不匹配被跳过。`);
}

const aps = [];
for (const [bssid, vals] of acc) {
  if (!vals.length) continue;
  const sorted = [...vals].sort((a, b) => a - b);
  const n = meta.get(bssid);
  aps.push({
    ap: apName(bssid),
    bssid,
    median: sorted[Math.floor(sorted.length / 2)],
    raw: vals.join('/'),
    band: n.band,
    channel: n.channel,
    radio: n.radio,
    ssid: n.ssid,
  });
}
aps.sort((a, b) => a.ap.localeCompare(b.ap) || b.median - a.median);

const result = {
  kind: 'ap-signals',
  ts: new Date().toISOString(),
  rounds,
  previousSsid: previous,
  aps,
};

if (args['keep-connected'] && previous) {
  connect(previous);
  await sleep(6000);
}

const json = JSON.stringify(result, null, 2);
if (typeof args.out === 'string') {
  fs.writeFileSync(args.out, json, 'utf8');
  console.error(`[scan-ap] ${aps.length} 个 BSSID → ${args.out}`);
} else {
  console.log(json);
}
