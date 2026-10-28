---
name: wifi-site-survey
description: 家庭/小办公 WiFi 点位实测：走到每个位置，扫各 AP 信号、逐个 SSID 测吞吐，输出可直接写进报告的数据。当用户说「测下这里的网速」「这个位置信号怎么样」「哪个路由器信号强」「全屋每个房间测一遍」「换完路由测一下覆盖」「WiFi 哪里是死角」时使用。也用于判断该连哪个 SSID、哪个位置该放 AP、中继是否值得买。核心是四个已踩过的测量坑（连着扫信号偏低、刚连上测速偏低、多线程相加虚高、镜像站拦 UA）。
---

# WiFi 点位实测（wifi-site-survey）

> ✅ 状态：Windows 11 实机验证通过（全屋 7 个点位）

## 原子边界：做什么 / 不做什么

| 做 | 不做（去哪） |
|---|---|
| 扫该位置各 AP 的信号（断开扫 3 次取中位） | 改路由器配置（各厂商后台 / App） |
| 逐个 SSID 连上测吞吐（真实字节数 ÷ 时间） | 生成报告 PDF（按项目自己的模板写） |
| 输出 JSON / Markdown 数据，供人写报告 | 判断「该买什么设备」——那是人的决策 |

## 四个测量坑（全都实测踩过，绕过去结论会错）

1. **连着 WiFi 扫信号，读数偏低**
   连着的网卡只在当前信道工作，其它信道读的是缓存。同一位置：连着扫 `AP-1 5G` = **45%**，断开扫 = **94%**。
   → 脚本先 `netsh wlan disconnect`，扫 3 次取中位，再重连。

2. **刚连上就测速，偏低 2–3 倍**
   关联完成后速率还在爬坡。同一位置先测 **209 Mbps**、预热后 **581 Mbps**。
   → `measure-ssid.mjs` 内置 1.5 秒预热（跑一次不计结果），再正式计时。

3. **多线程 curl 的自报速率相加会虚高**
   每个 curl 报自己的平均速率，启动时间差 1–3 秒，相加把峰值当整体：算出 **1625**，网卡实际 **889**。
   → `lib/throughput.mjs` 用 Node 发 Range 请求，数 socket 上真实收到的字节数 ÷ 真实耗时。

4. **镜像站会拦 Node 的默认 UA**
   默认 UA 请求 TUNA 返回 **403**（body 是 1.5 KB HTML），看起来像「下载很慢」。
   → 固定带 `User-Agent: wifi-test/1.0`，并把非 206 返回标成 `suspect`。

## 用法

```bash
cd scripts

# 测一个位置（扫信号 + 逐个 SSID 测吞吐），约 2 分钟
node run-position.mjs --place "楼上大厅"

# 只扫信号（不下载，约 40 秒）
node run-position.mjs --place "二楼书房" --signal-only

# 只测指定 SSID / 改并发与时长
node run-position.mjs --place "车间" --ssid "我的WiFi-5G" --ssid "我的WiFi" --threads 8 --seconds 6
```

结果三样：

1. 控制台输出（边测边看）
2. 追加到 `../position-log.md`（人读：A=各 AP 信号，B=各 SSID 实测）
3. 落一份 `../records/<id>.json`（机读：多点位汇总的输入）

## 结构（一动词一脚本）

```
scripts/
├─ run-position.mjs          编排①：扫信号 → 逐个测 SSID → 排版 + 落记录
├─ aggregate.mjs             原子④：多点位汇总（纯分析，不碰网络）
├─ atoms/
│   ├─ scan-ap.mjs           原子①：断开 → 连扫 N 次 → 各 BSSID 信号 JSON
│   ├─ measure-ssid.mjs      原子②：连一个 SSID → 预热 → 测吞吐 → JSON
│   └─ render-report.mjs     原子③：读 JSON → 输出 Markdown（不碰网络）
└─ lib/
    ├─ config.mjs            AP 名表（按 MAC 前缀）、SSID 清单、测速源
    ├─ wifi.mjs              netsh 封装（连/断/读状态/列网络/ping）
    └─ throughput.mjs        Range 下载测速（真实字节数）
```

四个原子都能单独跑：

```bash
node atoms/scan-ap.mjs --out scan.json
node atoms/measure-ssid.mjs --ssid "我的WiFi-5G" --out m1.json
node atoms/render-report.mjs --place "楼上大厅" --scan scan.json --measure m1.json
node aggregate.mjs --dir ../records                  # 多点位汇总
```

## 多点位汇总（aggregate.mjs）

采集阶段只回答「**这个位置**怎么样」；`aggregate.mjs` 回答**位置之间**的问题 —— 它不碰网络，可以反复重算。

```bash
node aggregate.mjs --dir ../records                    # 全部点位
node aggregate.mjs --dir ../records --json out.json    # 同时出机器可读
node aggregate.mjs --dir after --compare before        # 改造前后对比
node aggregate.mjs --dir ../records --all              # 同点位多条记录全保留
```

输出五节：

| 节 | 回答什么 | 读法 |
|---|---|---|
| 一、主指标 | 这个位置**该连哪个** | 按实测吞吐排，不是按信号排 |
| 二、信号矩阵 | 每个位置的信号全景 | `·` = 扫不到（不是 0） |
| 三、同信道冲突 | 哪些 AP 挤在同一信道 | 同频会互等空口 |
| 四、每台 AP 的覆盖 | 谁装得偏、谁穿墙损耗大 | 可见点位少 = 装错位置 |
| 五、前后对比 | 改造到底值不值 | 需要 `--compare` |

### 三条已经内置的判断规则（都是踩过的坑）

1. **不无脑「5G 优先」**：5G 只剩十几兆、2.4G 反而更快时推 2.4G。
   实测：一楼卫生间 5G 13.9 Mbps，2.4G 44.7 Mbps → 推 `我的WiFi`(2.4G)。
2. **<50 Mbps 标「⚠️ 偏弱」**，不把死角当成推荐。
3. **同点位多条记录默认只留一条**：优先留有吞吐的那条（仅扫信号的记录会把整点位降级成没速度），其次才比时间。要全看加 `--all`。

### 会主动告警的两件事

- **命名不一致**：`AP-1` 与 `AP-1-5G` 是同一台设备的不同写法 → 矩阵里会分裂成两列，汇总前应统一 `config.mjs` 的 `AP_NAMES`。
- **跳过的文件**：原子输出（`kind: ap-signals` / `ssid-measure`）不是记录，需要先经 `run-position.mjs` 合成，脚本会逐个报出来。

## 数据契约

**scan-ap.mjs**
```json
{ "kind": "ap-signals", "ts": "...", "rounds": 3, "previousSsid": "我的WiFi-5G",
  "aps": [ { "ap": "AP-1-5G", "bssid": "aa:bb:cc:dd:ee:ff",
             "median": 95, "raw": "95/95/95", "band": "5 GHz", "channel": "36" } ] }
```

**measure-ssid.mjs**
```json
{ "kind": "ssid-measure", "ssid": "我的WiFi-5G", "state": "ok",
  "bssid": "aa:bb:cc:dd:ee:ff", "ap": "AP-1-5G", "band": "5 GHz", "channel": "36",
  "signal": "94%", "phy": "2402", "mbps": 846.0, "bytes": 547714040,
  "seconds": 6.12, "httpStatus": [206,206], "gwMs": 4.2 }
```

`state` 三态：`ok` / `suspect`（HTTP 非 206 或吞吐 <1 Mbps）/ `fail`（连不上）。

## 换一台机器/换个家怎么改

> 2026-10-28 实测补的三条：换到「不是自己家」的网络时，
> `scan-ap` 会因为 MAC 前缀全不匹配而**扫出 0 条**。现在会明确喊出来，
> 但根因还是配置没改 —— 先把 `AP_NAMES` 换成本机的。

## 换一台机器/换个家怎么改

只需要改 `lib/config.mjs` 三处：

| 常量 | 改什么 |
|---|---|
| `AP_NAMES` | MAC 前缀 → 人看得懂的名字（前缀从 `netsh wlan show networks mode=bssid` 里抄前 8 位） |
| `DEFAULT_SSIDS` | 要逐个测的 SSID 清单 |
| `DEFAULT_URL` | 测速源（**必须支持 Range**；国内推荐清华 TUNA 镜像） |

其余脚本不用动。

## 读数的经验判据

| 现象 | 含义 |
|---|---|
| 加线程不涨（1→4→8 持平） | 管道上限到了（百兆链路 / 端口瓶颈） |
| 5G 与 2.4G 差 5–10 倍 | 正常；2.4G 封顶通常 130–260 Mbps |
| 信号高、吞吐低、零丢包、延迟抖 | **空口被重传拖住**（多径/同频干扰），不是信号弱 |
| 同一位置忽快忽慢差好几倍 | 连到了不同的 AP（同名 SSID 粘网），看 BSSID |
| 两个 AP 同信道（如都 ch3） | 互扰，改开一个到 ch1/ch6/ch11 |

## 平台限制

- 只支持 Windows（依赖 `netsh wlan`）
- 扫描会**断开并重连 WiFi**，运行期间网络短暂中断
- 中文 SSID 通过 `cmd /c "chcp 65001 && netsh ..."` 取，避免 GBK 乱码
- **解析依赖 netsh 的英文标签**（`Signal` / `Band` / `Channel` / `BSSID`）。
  实测 Windows 11 build 29000 即使用户界面是 zh-CN，netsh 输出的仍是英文；
  但**旧版 Windows 10 中文系统输出「信号 / 频带 / 信道」**，正文解析会全部匹配失败，
  结果是**每台 AP 都报 0% 且不报错**。换机器后第一件事：先手工跑一遍
  `netsh wlan show networks mode=bssid` 看标签语言，不是英文就先改 `lib/wifi.mjs` 的正则。
- **测完连回「扫描前那个」SSID**（不是配置里的第一个）—— 后者在别人的网络上不存在，会把人直接断网
- **输出目录**默认是当前工作目录下的 `survey-out/`，可用环境变量 `WIFI_SURVEY_OUT` 覆盖；
  不再写死本机绝对路径
- **扫到 0 个自家 AP 时会打印警告**并给出修改指引，不再静默返回空数组（空数组会被读成「这里没有 WiFi」）
