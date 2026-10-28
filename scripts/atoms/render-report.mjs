#!/usr/bin/env node
// 原子③：把测量结果渲染成 Markdown（并可选追加到记录文件）
//
// 输入是 scan-ap / measure-ssid 产出的 JSON；不碰网络，纯排版。
//
// 用法：
//   node atoms/render-report.mjs --place "楼上大厅" --scan scan.json --measure m1.json --measure m2.json
//   node atoms/render-report.mjs --place "楼上书房" --scan scan.json --append
//   node atoms/render-report.mjs --place X --scan scan.json --log <输出目录>/position-log.md

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_OUT, parseArgs } from '../lib/config.mjs';

const args = parseArgs();

function asList(v) {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

const place = args.place;
if (!place) {
  console.error('缺少 --place');
  process.exit(1);
}

const scanFile = args.scan;
if (!scanFile || !fs.existsSync(scanFile)) {
  console.error('缺少或找不到 --scan 指定的 JSON');
  process.exit(1);
}
const scan = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
const measures = asList(args.measure)
  .filter((f) => fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));

const ts = new Date().toLocaleString('zh-CN', { hour12: false });
const md = [];
md.push(`## ${place}（${ts}）`, '');

// A. 信号
md.push('### A. 各 AP 信号', '');
md.push('| AP | BSSID | 频段/信道 | 信号 | 三次原始值 |', '|---|---|---|---|---|');
for (const a of scan.aps ?? []) {
  md.push(`| ${a.ap} | \`${a.bssid}\` | ${a.band || '-'} ${a.channel ? 'ch' + a.channel : ''} | **${a.median}%** | ${a.raw} |`);
}
md.push('');

// B. 吞吐
if (measures.length) {
  md.push('### B. 逐个 SSID 实测', '');
  md.push('| SSID | 实际连的 AP | 频段/信道 | 信号 | 协商 | 吞吐 | 网关延迟 |');
  md.push('|---|---|---|---|---|---|---|');
  for (const m of measures) {
    if (m.state === 'ok' || m.state === 'suspect') {
      const flag = m.state === 'suspect' ? ' ⚠️' : '';
      md.push(
        `| \`${m.ssid}\` | ${m.ap} | ${m.band} ch${m.channel} | ${m.signal} | ${m.phy} | **${m.mbps} Mbps**${flag} | ${m.gwMs ?? '-'} ms |`
      );
    } else {
      md.push(`| \`${m.ssid}\` | — | — | — | — | 连不上 | — |`);
    }
  }
  md.push('');
}

const text = md.join('\n');

// 输出
if (args.append || args.log) {
  let logFile = args.log;
  if (logFile === true || !logFile) logFile = path.join(DEFAULT_OUT, 'position-log.md');
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, '# 点位实测记录\n\n> 由 scripts/run-position.mjs 调用原子脚本生成。\n\n', 'utf8');
  }
  fs.appendFileSync(logFile, text + '\n', 'utf8');
  console.error(`[render-report] 已追加到 ${logFile}`);
} else {
  console.log(text);
}
