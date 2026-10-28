#!/usr/bin/env node
// 原子②：测一个 SSID
//
// 连上 → 读 BSSID/频段/信道/信号/协商 → 测吞吐 → ping 网关 → 输出 JSON
// 不负责扫信号（那是 scan-ap），不负责排版（那是 render-report）。
//
// 用法：
//   node atoms/measure-ssid.mjs --ssid "我的WiFi-5G"
//   node atoms/measure-ssid.mjs --ssid X --restore   # 测完连回原来的
//   node atoms/measure-ssid.mjs --ssid "办公室WiFi" --threads 8 --seconds 6 --out m.json

import fs from 'node:fs';
import { DEFAULT_URL, parseArgs, apName } from '../lib/config.mjs';
import { connect, waitConnected, currentSsid, field, pingAvg, defaultGateway, restoreConnection, sleep } from '../lib/wifi.mjs';
import { measureThroughput } from '../lib/throughput.mjs';

const args = parseArgs();
const ssid = args.ssid;
if (!ssid) {
  console.error('缺少 --ssid');
  process.exit(1);
}

const threads = Number(args.threads ?? 8);
const seconds = Number(args.seconds ?? 6);
const url = args.url ?? DEFAULT_URL;
const userAgent = args.ua ?? 'wifi-test/1.0';

// 加 --restore 时，测完连回这里记下的那个
const previousSsid = args.restore ? currentSsid() : '';

connect(ssid);
const ok = await waitConnected(ssid);

let result;
if (!ok) {
  result = { kind: 'ssid-measure', ssid, state: 'fail', got: currentSsid(), ts: new Date().toISOString() };
} else {
  const bssid = field('AP BSSID');
  const band = field('Band');
  const channel = field('Channel');
  const signal = field('Signal');
  const phy = field('Receive rate (Mbps)').replace(/[^\d.]/g, '');

  // 预热：刚连上时速率还在爬坡，直接计时会偏低（实测同一位置 209 vs 581）。
  // 先跑 1.5 秒不考虑结果，再正式计时。
  await measureThroughput(url, { threads: 2, seconds: 1.5, userAgent });
  await sleep(500);

  const tp = await measureThroughput(url, { threads, seconds, userAgent });
  // 网关不写死：探不到就跳过 ping（宁可缺一项，也不给一个假数字）
const gwMs = pingAvg(defaultGateway(), 5);

  // 判断测速是否真的成功（镜像站可能返回 403 的 HTML，字节数极低）
  const suspicious = tp.mbps < 1 || tp.statuses.some((s) => s === 403 || s === 404);

  result = {
    kind: 'ssid-measure',
    ssid,
    state: suspicious ? 'suspect' : 'ok',
    bssid,
    ap: apName(bssid),
    band,
    channel,
    signal,
    phy,
    mbps: Number(tp.mbps.toFixed(1)),
    bytes: tp.bytes,
    seconds: Number(tp.seconds.toFixed(2)),
    httpStatus: tp.statuses,
    gwMs,
    ts: new Date().toISOString(),
  };
}

// --restore：测完连回测之前那个。
// 默认不还原 —— 这个原子的动词就是「连上去测」，批量连测 N 个 SSID 时
// 每次都还原会把时间全花在反复关联上；批量场景由 run-position 在最后统一还原一次。
if (args.restore && previousSsid && previousSsid !== ssid) {
  const back = await restoreConnection(previousSsid);
  result.restoredTo = back ? previousSsid : null;
  console.error(back ? `[measure-ssid] 已连回 ${previousSsid}` : `[measure-ssid] ⚠️  连回 ${previousSsid} 失败`);
}

const json = JSON.stringify(result, null, 2);
if (typeof args.out === 'string') {
  fs.writeFileSync(args.out, json, 'utf8');
  console.error(`[measure-ssid] ${ssid} → ${args.out}`);
} else {
  console.log(json);
}
