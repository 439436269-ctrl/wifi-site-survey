#!/usr/bin/env node
// 编排层：测一个位置
//
// 只做调度与传参，能力全部调原子脚本：
//   scan-ap.mjs       扫各 AP 信号     → scan.json
//   measure-ssid.mjs  测单个 SSID      → mN.json
//   render-report.mjs 排版并追加记录
//
// 除了 Markdown 日志，还会落一份结构化记录（records/<id>.json），
// 供 aggregate.mjs 做跨点位分析 —— 没有这份记录，多点位汇总就没有输入。
//
// 用法：
//   node run-position.mjs --place "楼上大厅"
//   node run-position.mjs --place "楼上书房" --signal-only
//   node run-position.mjs --place "车间座位" --threads 8 --seconds 6
//   node run-position.mjs --place "楼上大厅" --ssid "我的WiFi-5G" --ssid "我的WiFi"
//   node run-position.mjs --place X --scan-only-rounds 5

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SSIDS, DEFAULT_OUT, parseArgs } from './lib/config.mjs';
import { currentSsid } from './lib/wifi.mjs';

// 主动销毁测速 socket 时，偶发 unhandledRejection（Node 会因此以 1 退出）。
// 这类噪声不该让整轮测试被判定失败，所以只记警告、不改变退出码。
process.on('unhandledRejection', (e) => {
  console.error('[warn] unhandledRejection: ' + (e && e.message ? e.message : e));
});

const args = parseArgs();
const place = args.place;
if (!place) {
  console.error('缺少 --place，例如：node run-position.mjs --place "楼上大厅"');
  process.exit(1);
}

const signalOnly = Boolean(args['signal-only']);
const threads = String(args.threads ?? 8);
const seconds = String(args.seconds ?? 6);
const rounds = String(args.rounds ?? 3);
const outDir = args.out ?? DEFAULT_OUT;
const logFile = args.log && args.log !== true ? args.log : path.join(outDir, 'position-log.md');
const recordDir = args.records && args.records !== true ? args.records : path.join(outDir, 'records');

const ssids = args.ssid ? [].concat(args.ssid) : DEFAULT_SSIDS;

// 记下扫描前的连接：兜底重连必须连回「这一个」，
// 而不是配置里的第一个 SSID —— 后者在别人的网络上根本不存在，会把人直接断网。
const previousSsid = currentSsid();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wifi-pos-'));
const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const atom = (name) => path.join(here, 'atoms', name);

function step(title) { console.log(`\n=== ${title} ===`); }

function node(file, argv) {
  return execFileSync(process.execPath, [file, ...argv], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

try {
  // ① 扫信号
  step('[1/3] 扫描各 AP 信号（断开 → 连扫取中位）');
  const scanJson = path.join(tmp, 'scan.json');
  node(atom('scan-ap.mjs'), ['--rounds', rounds, '--out', scanJson]);
  const scan = JSON.parse(fs.readFileSync(scanJson, 'utf8'));
  for (const a of scan.aps) {
    console.log(`  ${(a.ap + ' ' + a.bssid).padEnd(30)} ${String(a.median).padStart(3)}%  (${a.raw})`);
  }

  // ② 逐个 SSID
  const measureFiles = [];
  const measureObjs = [];
  if (!signalOnly) {
    step(`[2/3] 逐个 SSID 测吞吐（${threads} 路 × ${seconds}s，统计实际字节数）`);
    for (const [i, ssid] of ssids.entries()) {
      const f = path.join(tmp, `m${i + 1}.json`);
      node(atom('measure-ssid.mjs'), ['--ssid', ssid, '--threads', threads, '--seconds', seconds, '--out', f]);
      const m = JSON.parse(fs.readFileSync(f, 'utf8'));
      measureFiles.push(f);
      measureObjs.push(m);
      if (m.state === 'fail') {
        console.log(`  ${ssid.padEnd(20)} 连不上`);
      } else {
        const flag = m.state === 'suspect' ? '  ⚠️ 测速可疑' : '';
        console.log(
          `  ${ssid.padEnd(20)} ${String(m.band).padEnd(9)} ${String(m.bssid).padEnd(18)} ` +
          `sig=${String(m.signal).padStart(4)}  ${String(m.mbps).padStart(7)} Mbps  gw=${m.gwMs ?? '-'}ms${flag}`
        );
      }
    }
  }

  // ③ 排版
  step('[3/3] 生成记录');
  const renderArgs = ['--place', place, '--scan', scanJson, '--log', logFile];
  for (const f of measureFiles) renderArgs.push('--measure', f);
  node(atom('render-report.mjs'), renderArgs);

  // ④ 结构化记录（供 aggregate.mjs）
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const id = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}-${place.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)}`;
  const record = {
    id,
    place,
    ts: now.toISOString(),
    signals: (scan.aps ?? []).map((a) => ({ ap: a.ap, bssid: a.bssid, median: a.median, band: a.band, channel: a.channel })),
    measures: measureObjs,
  };
  fs.mkdirSync(recordDir, { recursive: true });
  const recordFile = path.join(recordDir, `${id}.json`);
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2), 'utf8');

  console.log(`\n完成：${logFile}`);
  console.log(`记录：${recordFile}`);
  process.exitCode = 0;
} catch (e) {
  console.error('\n[error] ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  // 扫完后网卡可能处于断开状态 —— 连回扫描前那个，而不是配置里的第一个
  try {
    const back = previousSsid || ssids[0];
    if (back) {
      execFileSync('cmd', ['/c', `chcp 65001 >nul && netsh wlan connect name="${back}"`], { stdio: 'ignore' });
      console.error(`[reconnect] 已尝试连回：${back}`);
    }
  } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
