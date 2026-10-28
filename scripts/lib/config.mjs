// 配置：自家 AP 的 MAC 前缀、要测的 SSID 清单、测速源
//
// ★ 换一台机器 / 换一个家，只需要改这个文件的三个常量。
//   前缀从 `netsh wlan show networks mode=bssid` 的输出里抄 BSSID 的前 8 位。
import path from 'node:path';

// MAC 前缀（小写、冒号分隔、8 位）→ 人看得懂的名字
// 不填的话 scan-ap 会一台 AP 都扫不到（它会明确告警，不会静默返回空）
export const AP_NAMES = {
  'aa:bb:cc': '客厅AP-5G',
  'aa:bb:cd': '客厅AP-2.4G',
  'aa:bb:ce': '卧室AP',
};

export const OWN_PREFIX = Object.keys(AP_NAMES);

// 要逐个连上去测吞吐的 SSID
export const DEFAULT_SSIDS = ['你的WiFi-5G', '你的WiFi'];

// 测速源：必须支持 HTTP Range（返回 206）。
// 用国内镜像时注意：不带 User-Agent 会被拦（见 lib/throughput.mjs 的说明）
export const DEFAULT_URL =
  'https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso';

// 输出目录：默认落在当前工作目录下的 survey-out/
// 要换位置就设环境变量 WIFI_SURVEY_OUT
export const DEFAULT_OUT = process.env.WIFI_SURVEY_OUT || path.resolve(process.cwd(), 'survey-out');

/** 简易参数解析：--key value / --flag */
export function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[k] = next; i++; }
    else out[k] = true;
  }
  return out;
}

/** BSSID → 名字；找不到就退回 MAC 前 8 位 */
export function apName(bssid) {
  const b = String(bssid || '').toLowerCase();
  return AP_NAMES[b.slice(0, 8)] || b.slice(0, 8);
}
