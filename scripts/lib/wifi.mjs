// netsh wlan 的薄封装。只做「读状态 / 连 / 断 / 列网络」，不做业务判断。
import { execSync } from 'node:child_process';

/**
 * 跑命令并强制 UTF-8 输出。
 * netsh 默认按控制台代码页（zh-CN 是 GBK）输出，中文 SSID 会乱码，
 * 所以先 chcp 65001 再执行。
 */
export function run(cmd, timeout = 20000) {
  try {
    return execSync(`cmd /c "chcp 65001 >nul && ${cmd}"`, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    return e.stdout ? e.stdout.toString() : '';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 当前连着的 SSID，没连返回 '' */
export function currentSsid() {
  const m = run('netsh wlan show interfaces').match(/^\s*SSID\s*[:：]\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

/**
 * netsh 的字段标签随系统语言变化：
 *   Windows 11（实测 build 29000）zh-CN 界面也输出英文；
 *   旧版 Windows 10 中文系统输出「信号 / 频带 / 信道」，且用全角冒号。
 * 这里给每个字段配一组别名，两种都能认。认不出时返回 0/空 —— 所以
 * **换机器后要先手工跑一遍 netsh，确认拿到的不是一堆 0**。
 */
const ALIASES = {
  'Signal': ['Signal', '信号'],
  'Band': ['Band', '频带', '频段'],
  'Channel': ['Channel', '信道'],
  'Radio type': ['Radio type', '无线电类型'],
  'AP BSSID': ['AP BSSID', '接入点 BSSID', 'AP BSSID'],
  'Receive rate (Mbps)': ['Receive rate (Mbps)', '接收速率(Mbps)', '接收速率'],
  'Transmit rate (Mbps)': ['Transmit rate (Mbps)', '传输速率(Mbps)', '传输速率'],
  'SSID': ['SSID'],
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 在一段 netsh 输出里，按「英文名 + 别名」找一个字段的值 */
export function pickLabel(text, name) {
  const names = ALIASES[name] ?? [name];
  for (const n of names) {
    // 值可能是全角或半角冒号
    const m = text.match(new RegExp(`^\\s*${esc(n)}\\s*[:：]\\s*(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return '';
}

/** 当前连接的某个字段，如 'AP BSSID' / 'Signal' / 'Receive rate (Mbps)' */
export function field(name) {
  return pickLabel(run('netsh wlan show interfaces'), name);
}

export function connect(ssid) {
  return run(`netsh wlan connect name="${ssid}"`);
}

export function disconnect() {
  return run('netsh wlan disconnect');
}

/** 等某个 SSID 连上，成功返回 true */
export async function waitConnected(ssid, tries = 6, intervalMs = 2000) {
  for (let i = 0; i < tries; i++) {
    await sleep(intervalMs);
    if (currentSsid() === ssid) return true;
  }
  return false;
}

/** 一次扫描，返回 [{ssid, bssid, signal, band, channel, radio}]（原始，未过滤） */
export function listNetworks() {
  const lines = run('netsh wlan show networks mode=bssid').split(/\r?\n/);
  const nets = [];
  let ssid = '';
  for (let i = 0; i < lines.length; i++) {
    const sm = lines[i].match(/^SSID \d+\s*:\s*(.*)$/);
    if (sm) ssid = sm[1].trim();

    const bm = lines[i].match(/BSSID \d+\s*:\s*(\S+)/i);
    if (!bm) continue;

    const net = { ssid, bssid: bm[1].toLowerCase(), signal: 0, band: '', channel: '', radio: '' };
    for (let k = i + 1; k < Math.min(i + 10, lines.length); k++) {
      if (/BSSID \d+/i.test(lines[k])) break;
      const g = (re) => { const m = lines[k].match(re); return m ? m[1].trim() : null; };
      // 中英文标签都认（见 ALIASES 的说明）
      net.signal = Number(g(/(?:Signal|信号)\s*[:：]\s*(\d+)%/i) ?? net.signal);
      net.band = g(/(?:Band|频带|频段)\s*[:：]\s*(.+)$/i) ?? net.band;
      net.channel = g(/(?:Channel|信道)\s*[:：]\s*(\d+)/i) ?? net.channel;
      net.radio = g(/(?:Radio type|无线电类型)\s*[:：]\s*(.+)$/i) ?? net.radio;
    }
    nets.push(net);
  }
  return nets;
}

/** ping 网关，返回平均延迟（ms），失败返回 null */
/**
 * 自动探测本机默认网关。
 *
 * 写死一个固定网关在别人家里往往是错的（各厂商的出厂网关不在同一段），
 * 探不到就返回空字符串 —— 调用方据此跳过 ping，而不是测出一个假的延迟。
 */
export function defaultGateway() {
  const out = run('ipconfig');
  const m =
    out.match(/Default Gateway[.\s]*:\s*(\d+\.\d+\.\d+\.\d+)/i) ||
    out.match(/默认网关[.\s]*:\s*(\d+\.\d+\.\d+\.\d+)/);
  return m ? m[1].trim() : '';
}

export function pingAvg(host, count = 5) {
  if (!host) return null;
  const out = run(`ping -n ${count} ${host}`);
  const times = [...out.matchAll(/time[=<]\s*(\d+)/g)].map((m) => Number(m[1]));
  if (!times.length) return null;
  return Number((times.reduce((a, b) => a + b, 0) / times.length).toFixed(1));
}
