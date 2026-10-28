# wifi-site-survey

**家庭 WiFi 点位实测：走到每个位置，扫各 AP 的信号、逐个 SSID 测吞吐，最后汇总成一张矩阵和「该连哪个」的建议。**

做这件事的起因很朴素：家里 WiFi 不好用，但**说不清哪里不好**。
于是想测一遍——然后发现「测 WiFi」这件事比看起来脏得多，同一个位置能测出差一倍的数。

这个工具把绕过去的坑固化成了代码。

```
探针       每个点位：断开 → 连续扫 3 轮 → 各 BSSID 取中位
测速       逐个 SSID：连上 → 预热 1.5s → 数真实字节 ÷ 真实耗时
汇总       aggregate：信号矩阵 / 每点位推荐 / 同信道冲突 / 每台 AP 的覆盖 / 改造前后
```

## 四个坑（都实测踩过，绕过去结论会错）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| **连着 WiFi 扫信号** | 同一个 AP 连着扫 **45%**，断开扫 **94%** | 先断开，扫 3 轮取中位，再重连 |
| **刚连上就测速** | 同一位置先测 **209**，预热后 **581**（差 2.8 倍） | 连上后先跑 1.5 秒预热，不计入结果 |
| **多线程速率相加** | 16 线程算出 **1625**，网卡实际只有 **889** | 用「真实收到的字节数 ÷ 真实耗时」 |
| **镜像站拦 UA** | 默认 UA 请求 TUNA 返回 **403**（1.5 KB HTML），看着像"很慢" | 固定带 `User-Agent`，并把非 206 标成可疑 |

第二条和第三条最容易骗人：并发任务共享同一条链路，各自报出来的是"我抢到的"，
加起来会得出一个物理上不存在的带宽。

## 要求

- **Windows**（依赖 `netsh wlan`；macOS/Linux 需要自己替换采集层，见下）
- **Node.js ≥ 18**（零依赖，不用 npm install）
- 运行期间会**断开并重连 WiFi**，网络会短暂中断

## 快速开始

```bash
git clone https://github.com/439436269-ctrl/wifi-site-survey.git
cd wifi-site-survey

# 1) 改成你家的 AP：打开 scripts/lib/config.mjs，填 AP_NAMES / DEFAULT_SSIDS
#    前缀从下面这条命令的输出里抄 BSSID 前 8 位
netsh wlan show networks mode=bssid

# 2) 走到一个位置，测一遍（约 2 分钟）
node scripts/run-position.mjs --place "二楼书房"

# 3) 换个位置再来一次；全部测完做汇总
node scripts/aggregate.mjs --dir survey-out/records
```

产出的三样东西：

| 产物 | 给谁看 |
|---|---|
| 控制台输出 | 边测边看 |
| `survey-out/position-log.md` | 人读的 Markdown 记录 |
| `survey-out/records/<id>.json` | 机读，`aggregate` 的输入 |

### 只扫信号（不下载，约 40 秒）

```bash
node scripts/run-position.mjs --place "二楼书房" --signal-only
```

### 换设备 / 换家

只改 `scripts/lib/config.mjs` 的三个常量：

| 常量 | 改什么 |
|---|---|
| `AP_NAMES` | MAC 前缀（8 位）→ 名字 |
| `DEFAULT_SSIDS` | 要逐个测的 SSID |
| `DEFAULT_URL` | 测速源，**必须支持 Range** |

其余脚本不用动。

## 汇总分析（aggregate）

```bash
node scripts/aggregate.mjs --dir survey-out/records              # 全部点位
node scripts/aggregate.mjs --dir after --compare before          # 改造前后对比
node scripts/aggregate.mjs --dir records --json out.json         # 同时出机器可读
```

输出五节：

| 节 | 回答什么 |
|---|---|
| 一、主指标 | 这个位置**该连哪个**（按实测吞吐排，不是按信号） |
| 二、信号矩阵 | 每个位置的信号全景（`·` = 扫不到，不是 0） |
| 三、同信道冲突 | 哪些 AP 挤在同一信道 |
| 四、每台 AP 的覆盖 | 可见点位少 = 装错位置；落差大 = 穿墙损耗 |
| 五、前后对比 | 需要 `--compare` |

### 里面沉淀了三条判断规则

都是实测踩出来的：

1. **不无脑「5G 优先」** —— 5G 只剩十几兆、2.4G 反而更快时推 2.4G。
   实测：某位置 5G 只有 13.9 Mbps，2.4G 有 44.7 Mbps。按"5G 优先"会给出一个用不了的推荐。
2. **低于 50 Mbps 标「偏弱」**，不把死角当成"推荐连接"。
3. **同点位多条记录只留一条**，且优先留有吞吐的那条 —— 仅扫信号的记录会把整个点位降级成"没速度"。

## 读数的经验判据

| 现象 | 含义 |
|---|---|
| 加线程不涨（1→4→8 持平） | 管道上限到了（百兆链路 / 端口瓶颈） |
| 5G 与 2.4G 差 5–10 倍 | 正常；2.4G 封顶通常 130–260 Mbps |
| 信号高、吞吐低、零丢包、延迟抖 | **空口被重传拖住**（多径/同频干扰），不是信号弱 |
| 同一位置忽快忽慢差好几倍 | 连到了不同的 AP（同名 SSID 粘网），看 BSSID |
| 两台 AP 同信道 | 互扰，改开一台到别的信道 |

## 数据格式（跨平台的部分）

采集天生绑 OS：Windows `netsh`、macOS `wdutil`、Linux `nmcli`，三套互不相通。
**所以通用性放在了数据格式上** —— 只要记录长这样，用手机上的 WiFi 分析仪、
路由器后台或手抄都行，`aggregate.mjs` 照样算：

```json
{
  "place": "二楼书房",
  "ts": "2026-10-27T01:42:00.000Z",
  "signals": [
    { "ap": "客厅AP-5G", "bssid": "aa:bb:cc:dd:ee:ff", "median": 86, "band": "5 GHz", "channel": "44" }
  ],
  "measures": [
    { "ssid": "我的WiFi-5G", "state": "ok", "mbps": 943.9, "band": "5 GHz", "gwMs": 7.6 }
  ]
}
```

`state` 三态：`ok` / `suspect`（HTTP 非 206 或吞吐 < 1 Mbps）/ `fail`（连不上）。

## 平台限制

- 只支持 Windows（`netsh wlan`）
- **解析依赖 netsh 的英文标签**（`Signal` / `Band` / `Channel`）。
  实测 Windows 11 即使用户界面是中文，netsh 输出的也是英文；
  **旧版 Windows 10 中文系统输出「信号 / 频带 / 信道」**。已做双语解析并有回归测试
  （`npm test`），但只在 Windows 11 上验过 —— 换机器先手工跑一遍
  `netsh wlan show networks mode=bssid` 看标签语言。
- 扫到 0 个自家 AP 时会打印警告（通常是 `AP_NAMES` 没改），不会静默返回空
- 测完连回**扫描前那个** SSID，不是配置里的第一个

## 目录

```
scripts/
├─ run-position.mjs        编排：扫信号 → 逐个测 SSID → 排版 + 落记录
├─ aggregate.mjs           多点位汇总（纯分析，不碰网络）
├─ atoms/
│   ├─ scan-ap.mjs         原子①：断开 → 连扫 N 次 → 各 BSSID 信号
│   ├─ measure-ssid.mjs    原子②：连一个 SSID → 预热 → 测吞吐
│   └─ render-report.mjs   原子③：读 JSON → 输出 Markdown
└─ lib/
    ├─ config.mjs          ★ 换环境只改这里
    ├─ wifi.mjs            netsh 封装（连/断/读状态/列网络/ping）
    └─ throughput.mjs      Range 下载测速（真实字节数）

test/
└─ labels.test.mjs         netsh 中英双语标签的回归测试
```

## License

MIT
