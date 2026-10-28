/**
 * 双语标签回归测试：netsh 的字段名随系统语言变化，
 * 解析必须两种都能认，否则在中文 Win10 上会「全部 0% 且不报错」。
 *
 * 这里只测纯函数（pickLabel / 解析正则），不真的调 netsh —— 换机器也能跑。
 */
import test from 'node:test';
import assert from 'node:assert';
import { pickLabel } from '../scripts/lib/wifi.mjs';

// 英文（Windows 11，实测 build 29000，即使界面是 zh-CN 也输出英文）
const EN = `
    Name                   : WLAN
    SSID                   : 主WiFi-5G
    BSSID                  : aa:bb:cc:dd:ee:ff
    Signal                 : 94%
    Radio type             : 802.11ax
    Band                   : 5 GHz
    Channel                : 36
    Receive rate (Mbps)    : 2402
`;

// 中文（旧版 Windows 10，全角冒号）
const ZH = `
    名称                   : WLAN
    SSID                   : 主WiFi-5G
    BSSID                  : aa:bb:cc:dd:ee:ff
    信号                   : 94%
    无线电类型             : 802.11ax
    频带                   : 5 GHz
    信道                   : 36
    接收速率(Mbps)         : 2402
`;

test('英文标签能取到值', () => {
  assert.strictEqual(pickLabel(EN, 'Signal'), '94%');
  assert.strictEqual(pickLabel(EN, 'Band'), '5 GHz');
  assert.strictEqual(pickLabel(EN, 'Channel'), '36');
  assert.strictEqual(pickLabel(EN, 'Receive rate (Mbps)'), '2402');
  assert.strictEqual(pickLabel(EN, 'SSID'), '主WiFi-5G');
});

test('中文标签（全角冒号）也能取到同样的值', () => {
  assert.strictEqual(pickLabel(ZH, 'Signal'), '94%');
  assert.strictEqual(pickLabel(ZH, 'Band'), '5 GHz');
  assert.strictEqual(pickLabel(ZH, 'Channel'), '36');
  assert.strictEqual(pickLabel(ZH, 'Receive rate (Mbps)'), '2402');
  assert.strictEqual(pickLabel(ZH, 'SSID'), '主WiFi-5G');
});

test('双语结果一致 —— 这是解析层最重要的不变量', () => {
  for (const k of ['Signal', 'Band', 'Channel', 'Receive rate (Mbps)', 'SSID']) {
    assert.strictEqual(pickLabel(EN, k), pickLabel(ZH, k), `字段 ${k} 中英文解析不一致`);
  }
});

test('取不到的字段返回空字符串，不抛异常', () => {
  assert.strictEqual(pickLabel(EN, 'Transmit rate (Mbps)'), '');
  assert.strictEqual(pickLabel('完全无关的输出\n', 'Signal'), '');
  assert.strictEqual(pickLabel('', 'Signal'), '');
});

test('字段名不跨行误匹配（只认行首的标签）', () => {
  const tricky = '    Description : Signal is fine\n    Signal : 88%\n';
  assert.strictEqual(pickLabel(tricky, 'Signal'), '88%');
});
