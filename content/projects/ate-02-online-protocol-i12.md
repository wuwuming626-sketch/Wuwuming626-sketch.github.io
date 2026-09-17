+++
title = 'ATE-02 联机协议与 I12 对标实现'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 2
+++

H2E 的怪事是这样的：组合键能把机器稳稳送进工厂 ATE，可同样的代码一走联机，就原地失败（问题单 #1）。一条路通、一条路死，最后揪出来的真凶是 opt43 钩子压根没装上，工厂 DHCP 也没起来。旁边 I12-V2 更磨人：按下 `*` 进 ATE，等的时间比配置的 5 s 长出一大截。这案子得从头讲。

## 概述

本文汇总五份源材料，覆盖三条主线：

1. **I12-V2（BK7258）ATE 需求与实现方案**：进入方式（单键长按）、联机测试项清单、单机极简 ATE、老化规格、硬件抽象层补充。源为 `i12-V2_ATE_implementation_plan.md`（方案版 v1.0，2026-07-08）与 `I12-V2_ATE.txt`（现场调试与命令记录）。
2. **联机 ATE 的协议链路与 LINE 测试项**：从 FCT 下发 TCP 报文到各测试项 handler 的调用链，以及 I12 上 LINE（line_in/line_out）回环的完整控制面与数据面路线。
3. **两个调试案例**：工厂联机 ATE 失败（H2E，问题单 #1）的根因与修复；ATE「MAC 清除」流程的抓包+串口交叉验证。

本组件对应代码库路径：`sdk-repo/ap/components/bk_thirdparty/bk_ate/`（源文档基于本地工作副本 `~/work/ate` 下的同名路径）。老平台侧对应 `legacy-repo/vcore/platform/ate/`（协议核心）与 `legacy-repo/legacy-app/ate/`（产品层实现）。

| 源文件 | 主要贡献 |
|--------|----------|
| `i12-V2_ATE_implementation_plan.md` | 架构复用分析、12 项联机测试项、Kconfig 设计、实施顺序 |
| `I12-V2_ATE.txt` | 编译命令、LED/按键/音频实物对应、增益调试命令序列、分区检查 |
| `ATE_I12_LINE测试项调用路线.md` | LINE path1/2/3 控制面与数据面调用链、噪声门与软增益参数 |
| `ATE_MAC清除流程分析.md` | `set_id`/`write_mac`/`factory_reset` 三步链路与 Flash 行为 |
| `2026-06-13-factory-ate-online-failure-explanation.md` | 工厂路径联机失败的两个 bug、修复提交与验证结论 |

---

## 架构与关键路径

### 进入路径（I12-V2）

```
上电 → 长按 * 键 5s → 喇叭三声"滴滴滴" → ATE 预选模式
                                          ├── DHCP option 43 到达 → 联机 ATE
                                          └── 长按 # 键 5s → 三声提示 → 单机 ATE
                                                                        └── 按速拨键 → 老化测试
```

与既有平台（H2E/V50E/V60E）的差异：既有实现是「音量+ + 音量-」双键 2s 进入预选、静音键长按 2s 进单机；I12-V2 改为单键 `*` / `#` 长按，并以蜂鸣器三声代替屏幕提示（I12-V2 无 LCD，状态反馈只能用蜂鸣器 + LED）。

### 模块分层与复用度

| 层次 | 文件 | 处理方式 |
|------|------|----------|
| TCP 帧协议 | `src/bk_ate_frame.c` | 直接复用 |
| DHCP opt43 解析 | `src/bk_ate_dhcp.c` | 直接复用 |
| 会话管理 | `src/bk_ate_session.c` | 直接复用 |
| 命令分发（TR/CR/RC） | `src/bk_ate_vendor_msg.c` | 追加 TR profile 与处理分支（复用约 85%） |
| 矩阵扫描 / GPIO / keymap | `src/bk_ate_matrix.c`、`src/bk_ate_gpio.c`、`src/bk_ate_keymap.*` | 直接复用，需配置 I12-V2 矩阵与 GPIO 表 |
| 音频引擎 | `src/bk_ate_tone.c`、`src/bk_ate_voice_echo.c`、`src/bk_ate_i12_line_loop.c` | 复用；LINE 走 path3 独立 I2S 通路 |
| 数据写入/校验 | `src/bk_ate_mac.c`、`src/bk_ate_cert.c`、`src/bk_ate_http_simple.c` | 直接复用 |
| 按键服务 | `src/bk_ate_key.c` | 组合键检测由双键改为单键长按 |
| 老化引擎 / LED 驱动 | `src/bk_ate_aging.c`、`src/bk_ate_led.c` | LED 老化序列与 LED GPIO 表适配 |
| 硬件版本表 | `include/bk_ate_hw_version.h` | 新增 I12-V2 GPIO 表 + ADC 分压表 |
| 新增模块 | `bk_ate_beep`、`bk_ate_usb`、`bk_ate_temp`、`bk_ate_line_io`、`bk_ate_standalone_i12` | 蜂鸣器、U 盘检测、温度 ADC、Line I/O、极简单机入口 |

### 联机 ATE 通信链路

```
FCT（PC 工装，TCP）
  │  读帧 body，日志 session: rx cmd ...
  ▼
bk_ate_session.c
  ▼
bk_ate_cmd_dispatch(fd, body, len)
  ▼
bk_ate_vendor_msg.c        解析 msg=TR|CR|RC & cmd=... & action=...
  ▼
各测试项 handler（test_ip_call / test_tone / test_led / test_usb / …）
  ▼
send_rt(...) → msg=RT&cmd=...&result=success|failed&...
```

常用报文形态：

```text
msg=TR&cmd=test_ip_call&action=start&callee=...
msg=TR&cmd=test_ip_call&action=finished&callee=...
msg=RT&cmd=test_ip_call&result=success&reason=...
```

老平台侧协议一致，端口为 TCP **7810**（PC 作 Server、设备作 Client），帧为二进制头 `ff ee 00` + 文本参数体，参数为 URL 风格 `key=value&key=value`。

按键事件**不经过 FCT 命令**，走板端按键服务：矩阵扫描 → `bk_ate_key.c::dispatch_event()` → 广播给 LED/LCD/Tone/ip_call/keypad/aging 等模块。

### DHCP option 43 与工厂联网路径

工厂路径跳过正常 UI 与网络管理（NM），联网只依赖 `bk_ate` 工厂联网代码（`projects/voip-project/port/lwip/bk_ate_qemu_port.c` 及其配套 `qemu_dhcp_option.c/h`）：

```
组合键 factory_path
  → 安装 opt43 钩子 + 启动 bk_ate worker
  → 以太网 DHCP 取 IP
  → DHCP ACK 携带 option 43：Vendor_ATE=<PC IP>:<端口>
  → 设备 TCP 连接 ATE PC
  → 跑测试项
```

---

## 技术流程

### 进入方式改造（boot probe）

修改点集中在 `src/bk_ate_key.c` 的 `bk_ate_boot_probe_factory_combo()`。方案引入 Kconfig 互斥选项 `choice BK_ATE_FACTORY_ENTRY_MODE`：

- `BK_ATE_FACTORY_ENTRY_TWO_KEY`（默认）：保持双键行为；
- `BK_ATE_FACTORY_ENTRY_SINGLE_KEY_STAR`（I12-V2）：单键 `*` 长按。

单键模式的探测流程：加载 keymaps 找到 `*` 键（`BK_ATE_KEYVAL_STAR`）对应 matrix index → quiet 模式初始化矩阵 GPIO（不干扰正常启动）→ 轮询扫描，持续按住达到 `CONFIG_BK_ATE_BOOT_FACTORY_HOLD_MS`（默认 5000ms）且满足去抖 tick → 触发蜂鸣三声并返回 1；超时未达标则返回 0 走正常启动。另有 `CONFIG_BK_ATE_BOOT_ABORT_WALL_MS` 控制提前退出窗口。

蜂鸣实现有两条路径：GPIO 蜂鸣器（拉高 200ms / 间隔 200ms，重复三次，引脚由 `CONFIG_BK_ATE_BEEP_GPIO` 指定）或复用 `bk_ate_tone.c` 用 DAC 播 1kHz sine。预选阶段长按 `#`（`BK_ATE_KEYVAL_POUND`）≥ 5000ms 进入单机，逻辑参考既有 headless 预选结构。

### 联机 ATE 测试项与协议映射

测试项清单（除老化外，其余只做联机 ATE，不做单机 ATE）：

| # | 测试项 | 关键内容 |
|---|--------|----------|
| 1 | 版本检查 | 预设版本号比对，返回 model/appver/sysver/mac |
| 2 | 按键 | 3 速拨键 + 2 功能键(`*`/`#`) + 2 短路输入 = 7 键，位图记录按下的键，全部按过自动回 RT success |
| 3 | LED | 电源灯/程序灯（红绿双色）+ 速拨键灯（2 红 1 蓝）+ 短路输出×2 |
| 4 | Tone 音 | 喇叭播放 Tone（600Hz sine 复用） |
| 5 | USB | 读取 U 盘判定（新增 `bk_ate_usb.c`） |
| 6 | 语音回环 | RJ9 + 免提回环，人工用 `#`/`*` 确认 |
| 7 | 加热温感 | ADC 读值并按 NTC/热电偶换算，与标准值比对（新增 `bk_ate_temp.c`） |
| 8 | Line-out | DAC → Line-out 播固定频率 sine（新增） |
| 9 | Line-in | Line-in → ADC → DAC → Speaker 回环（新增） |
| 10 | Aging | 速拨键进入；LED 循环 + 喇叭粉噪 |
| 11/12 | SN/MAC/证书写入与校验 | 写 1 个 WAN MAC，软件自动分配 WiFi/BT MAC；证书下载后写入并校验 |

TR cmd 与实现映射（`s_tr_profiles[]` 变更要点）：`test_key`、`test_temperature` 由 `BK_ATE_TRP_DEFAULT` 改为 `BK_ATE_TRP_CUSTOM` 并在 `tr_handle_custom()` 内新增分支；新增 `test_usb`、`test_line_out`、`test_line_in` 三条 profile。`test_version`、`test_tone`、`test_led`、`test_voice_echo`、`test_aging`、`write_cert`、`check_cert`、`test_mac` 复用现有实现（`test_led` 需替换 I12-V2 灯效表）。

两条测试项的行为约定：

- `test_key`：start 时进入在线 UI 并注册监听，维护 7 位 bitmap，逐键点亮；finished 或超时停止监听。
- `test_aging`：**TCP 路径不允许启动**，直接返回 `failed&reason=key_combo_only`；老化只允许从单机路径（速拨键）触发。

### I12 LINE 通路（path1/2/3）

**LINE 没有独立的 FCT 命令**，它挂在 `test_ip_call` 会话里，由按键 DSS3 循环切换通路：

| path | 含义 | 音频路径 |
|------|------|----------|
| 1 | 板载免提（开 SPK_AMP） | mic → audiodevice → 喇叭 |
| 2 | 外接喇叭（关 PA） | 同上，PA 关 |
| 3 | **LINE** | ES8389 `line_in` → 自管 I2S → `line_out`（板载 DAC mute） |

控制面：FCT 只下发 `msg=TR&cmd=test_ip_call&action=start`，设备侧 `bk_ate_ip_call_test_session_begin()` 进入 armed，延时 `CONFIG_BK_ATE_IP_CALL_DELAY_MS`（默认 2000ms）后由独立任务 `ip_call_voice_start_worker` 启动回环（避免在 Timer 上下文开音频 DMA），默认 `s_i12_loop_path = 1`。操作员按 DSS3（keymap type=13，实机常见 keycode=65）两次，`1→2→3`，切入 LINE。

path=3 使能的接口调用顺序（`i12_path3_enable()`）：

```
1) bk_ate_i12_line_loop_i2s_up()   // 先起 I2S 主时钟，ES8389 作 slave 依赖 MCLK/BCLK
2) i12_codec_line_apply(1)        // es8389_xfer_start；CHAN_0=line in、CHAN_1=line out
                                  // 关闭 handset 混路；增益 0xBF（约 0dB，勿用 0xFF）
3) bk_ate_i12_line_loop_start()   // DMA RX/TX + 回环线程
```

同时调用 `bk_aud_dac_mute()`（避免与 codec 混音，日志 `dac muted`）；`bk_ate_voice_echo_i12_pa_wanted()` 在 path≠1 时返回 0，即关闭 SPK_AMP。

数据面（`bk_ate_i12_line_loop.c`，**不经 audiodevice**）：

```
line_in → ES8389 ADC(CHAN_0) → I2S RX DMA → 回环线程
   ll_rx_read → ll_linein_to_lineout_map（噪声门/软增益/单声道复制）→ ll_tx_write
→ I2S TX DMA → ES8389 DAC(CHAN_1) → line_out
```

参数：16kHz / stereo / 16bit / 约 10ms 帧；I2S 为 Master，`I2S_LRCOM_STORE_16R16L`，脚位 GPIO44~47。噪声门策略：peak < 80 直接静音（`gain_q8=0`）；peak < 120 不放大；否则按目标电平约 10000 做有限放大（最多约 ×4），并有过热衰减。周期日志 `linein L=… R=… gain_q8=… → TX`（每 100 帧）。

退出 path=3：再按 DSS3（`3→1`），或 `test_ip_call finished` / 会话断开触发 `bk_ate_app_voice_echo_stop() → i12_path3_disable()`（停 line loop，再 `i12_codec_line_apply(0)` 关 LINEIN/LINEOUT）；会话断开时 `bk_ate_session.c` 也会兜底调用 `bk_ate_ip_call_test_session_end()`。

**「怎么出声」的要点**：控制面由 FCT 起停会话、DSS3 切 path；数据面是工装音源进 `line_in`、从 `line_out` 听回环。ATE **不会主动生成 sine 推给 line_out**，也没有 line_in 输入则无声（噪声门还会把底噪压成静音）。这与 `test_tone`（板载喇叭 600Hz sine）和 `test_voice_echo`（板载 mic→喇叭）是三个不同用例。

### 单机 ATE 与老化（I12-V2 极简版）

新建 `src/bk_ate_standalone_i12.c`，设计原则是无屏（不依赖 LVGL）、无菜单、代码量预计 < 400 行。主循环：初始化矩阵 GPIO → 解析 `*`/`#`/速拨键 keycode → 允许 TCP session（以便 opt43 触发联机）→ 预选循环。

- 选到 ONLINE：TCP session 接管，永久等待；
- 选到 STANDALONE：蜂鸣三声 → 等待速拨键 → `bk_ate_aging_set_standalone_ui(1)` + `bk_ate_aging_burnin_start()` → 老化持续到断电。

新增 Kconfig：`BK_ATE_STANDALONE_I12`、速拨键 keyval（1/2/3 的 keymaps y 值）、`BK_ATE_I12_PRESELECT_HASH_HOLD_MS`（`#` 长按阈值，默认 5000ms）。

老化规格：

- 单色 LED：亮 29s → 灭 1s → 闪烁 30s（125ms 亮 / 875ms 灭，每秒 1 次），每分钟一周期循环；
- 双色/多色 LED：按颜色轮转，每种颜色 1 分钟；
- 喇叭：以电信号额定功率循环播放粉噪（`bk_ate_app_noise_start()` 现有实现已满足，无需修改）。

### MAC 清除 / 写号流程（三步）

ATE 软件执行「MAC 清除」时核心为三步，之后 `reboot`、`disconnect` 属收尾：

| 步骤 | 命令 | 作用 |
|------|------|------|
| 1 | `set_id` | 写入 ATE 测试 ID（临时，出厂重置后会被清掉） |
| 2 | `write_mac` | 将以太网 MAC 写为出厂默认值 `00:01:02:03:04:05`（即「清除 MAC」） |
| 3 | `factory_reset` | 恢复出厂设置，清用户配置与数据 |

调用链（老平台代码库）：

```
set_id:        setIdRequestReceived → _ateConfigIdSet → ateConfigIdSet → configSave
write_mac:     writeMacRequestReceived → _ateSetDeviceMac → ateSetDeviceMac（ateSys.c）
                 → nmDevMacSave（networkDev.c）→ ota_WriteCtrlBlock（ota_ctrl.c，擦写 NAND CTRL 分区）
factory_reset: factoryResetRequestReceived → _ateFactoryReset → ateFactoryReset
                 → storageReset(STORAGE_RESET_ALL)
reboot:        rebootRequestReceived → ateSysReboot → vcoreReboot(VCORE_REBOOT_SYS)
```

细节约定：

- 默认 MAC 常量在 `networkDev.c`/`ateSys.c` 中定义为 `{0x00,0x01,0x02,0x03,0x04,0x05}`，表示「已清除、待重新烧录」，**不是全 0**；`networkUtils.c` 用 `memcmp` 与默认值比对，命中则置 `gMacIsDef = 1`。
- `ateFactoryReset()` 显式把 `factoryResetReboot = FALSE` 后再 `storageReset(STORAGE_RESET_ALL)`，即 ATE 模式下禁止自动重启，等 PC 单独下发 `reboot` 再重启；`reboot` 前把该标志恢复为 `TRUE`。
- `wr` 响应里回传的 `wifi_mac` 是 WiFi 芯片（AIC8800）硬件 MAC，**不会被 `write_mac` 修改**，仅作信息回传；清除的是位于 CTRL 分区的以太网 MAC。
- `STORAGE_RESET_ALL` 主要清 `/userdata` 用户配置、数据库（电话本、通话记录）、证书/铃声/壁纸等。

命令名宏与注册位置：`legacy-repo/vcore/platform/ate/include/ateMsgParse.h` 定义 `CMD_SET_ID`/`CMD_WRITE_MAC`/`CMD_FACTORY_RESET`/`CMD_REBOOT`/`CMD_DISCONNECT`；`ateCmdProcess.c` 用 `ateCmdRegisterWithCmdName(...)` 注册 handler；`legacy-app/ate/src/ateMain.c` 注册平台回调（`ateSetDevMacCbRegister` 等）。

### I12-V2 硬件与实物对应

按键（keymap 定义，来自现场记录）：

| 位置 | keymap | 说明 |
|------|--------|------|
| 班长 | `keymap[70] = 15` | K6 DSS1，OUT0/IN5 |
| 监控室 | `keymap[72] = 16` | K18 DSS2，OUT2/IN5 |
| 监控中心 | `keymap[65] = 13` | K11 DSS3，OUT1/IN4 |

音频实物链路：

| 路 | 信号 → 芯片通路 | 用途 |
|----|-----------------|------|
| 路1 | `AUDP/AUDN → NS4110B → AMP_spk±`（使能 `GP48_AMP_EN`）；`Handfree_Mic± → MICP1/MICN1`（BK7258 板载 ADC） | RJ9/免提回环（mic + 喇叭） |
| 路2 | `Headset_Mic± → Codec_MIC2P/N`；`Codec_LOUTP/N → Headset_Spk±` | 手柄/外接喇叭（ES8389 MIC2 + 左声道出） |
| 路3 | `3.5mm LINE IN → Codec_MIC1P/N`；`Codec_ROUTP/N → Handfree_spk±`（页标题 LINE OUT） | Line-in/out（ES8389 MIC1 + 右声道出） |

注意：路3 输出座子在原理图上仍写作 `Handfree_spk`，实际由 ES8389 右声道驱动。

其它硬件点：

- LED 调试命令：`ap_cmd gpio_led 9 1`、`52 1`、`53 1`、`54 1`；
- 两路短路输入对应 GPIO **50、49**，读电平用 `ap_cmd gpio input_get 49`；
- 两路继电器端子为第 1 路 NO1/COM1/NC1、第 2 路 NO2/COM2/NC2，是标准干接点（无源开关），**接 LED 必须外接电源**；每路 LED 单独回路，COM 只接 LED，NO/NC 只接电源；
- 加热温感沿用 A11 用过的热敏电阻（关联任务 #2，热敏电阻与 ADC 转换）。

### ATE 上报的产品名映射

| 层级 | MB12 侧 | I12 侧 |
|------|---------|--------|
| 构建/目录/产品码 | `mb12-v2` / `MB12-V2` | `i12-v2` / `I12-V2` |
| 运行时 Model Info（sys config） | IP Intercom | I12 |
| PID 回退短名（`product_pid.json` ota 映射） | MB12 | I12 |

编译示例（源文档记录）：

```text
make clean && make bk7258 PROJECT=voip-project PRODUCT=MB12-V2 TARGET=board PRODUCT_VSOT_SUPPORT=1 VERSION=T123
```

---

## 调试过程记录

### 工厂联机 ATE 失败（H2E，问题单 #1，2026-06-13）

**现象**：组合键可进入工厂 ATE（`factory_path=1`），但**联机 ATE 失败**——PC 侧无 Socket 连接、话机侧无测试项。同期 Daily 610 可过，611 与 H2E 新版不行。

**定位手段**：在 `bk_ate` 工厂联网路径加诊断日志（`ate_dbg`），抓开机全过程；对照 `610/611` 与 `111` 三份串口日志定位断点。

**根因（两个 bug，111 日志已证实）**：

- Bug 1（致命）：opt43 钩子 / `bk_ate` worker 未安装。旧逻辑从网卡对象读名字拼 `st1`，再 `qemu_dhcp_option_add("st1", 43)` + `bk_ate_init()`；多核环境下名字读空，`install()` 静默 return，导致既无 `create bk_ate` 也无 `installed on st1`。日志特征：

```text
install probe: name=0000 num=6 ifname="" ok=0
install abort: ifname empty
```

- Bug 2：工厂 DHCP 从未启动。旧逻辑在 worker 中先判断 `netif_is_link_up()`，为 false 即 return，不再调用 `netifapi_dhcp_start`。驱动日志已打 `ETH link up`，但 worker 仍读到 0。日志特征：

```text
dhcp skip: link_up guard (why=boot/link)
```

关键认识：`netif_is_link_up()` 读的是 lwIP `netif->flags` 软件标志，不等价于 PHY 层「ETH link up」；旧代码在**非 tcpip 线程、未持 lwIP 锁**的情况下读该标志，SMP 下容易读到过期的 0（同一次启动中 `ext_cb link=1` 与 `link=0` 同时出现即为此证据）。

**与绑核可配置提交（`fc9bb265`）的关系**：H2E/V50E/V60E 默认均为 ETH 线程在 core1，`fc9bb265` 在默认配置下只是把 `rtos_core1_create_thread` 换成 `rtos_app_core_create_thread`，**仍在 core1**；日志显示改回 `rtos_core1` 后依旧失败，因此**不能归因于换核**。610 能过属时序碰巧。

**修改（commit `47919f613`）**：

| 改动 | 作用 |
|------|------|
| 改用 `qemu_dhcp_option_add_global(43)` | 不依赖 ifname，避免名字读脏导致 install 失败 |
| 在 `tcpip_callback` 中调用 `dhcp_start()` | 在 lwIP 规定线程操作 netif |
| 去掉 `netif_is_link_up` 前置检查 | 避免 worker 误读 link 拦住 DHCP |
| 仅用 `net_get_eth_handle()` 指针 | 不再拼 `st1` 字符串 |

变更文件：`projects/voip-project/port/lwip/bk_ate_qemu_port.c`、`projects/voip-project/port/lwip/qemu_dhcp_option.c/h`。

**验证结论与影响面**：修复版本（205544 等）联机 ATE 流程正常；旧代码 + 诊断日志版本可稳定复现失败。影响面为「`CONFIG_BK_ATE` 打开 + 组合键 factory_path」的联机 ATE；正常开机、NM 日常 DHCP、WiFi 等不受影响（global opt43 未注册时 hook 行为与改前 per-if 一致）。H2E/V50E/V60E Kconfig 绑核一致，修复通用，建议 V50E/V60E 各抽一台做联机冒烟。

### I12-V2 进入 ATE 耗时偏长

**现象**：从按下 `*` 到进入 ATE 体感很久。

**定位手段**：把上电到 ATE 的各阶段用日志/时间点切分。

**分段耗时**：

```
上电
  │  (~4s) Post 解压阶段，此时按 * 不被计入
  ▼
跳转 AP
  │  (~2s+) AP 自身初始化，并再次 init AW9523
  ▼
开始 boot probe     ← 日志：boot probe: single-key mode
  │  需稳按 *；配置写 5s，当前实现体感约 30s 才攒满
  ▼
held 满 → factory_path=1
  ▼
三声提示 → ATE 预选（再长按 # 进单机，keycode 70 的速拨键进老化等）
```

**结论**：总时长由「Post 解压 + AP 初始化 + 单键长按判定实现」叠加而成。配置项写的是 5000ms，但当前实现的计时方式导致实际要攒到远大于 5s 才判定成功，这是与预期不符之处。

### LINE / 喇叭通路调音排查（命令序列）

源文档记录的是一套「边放音边改增益、观察寄存器与听感」的现场排查手法，操作序列如下（`ap_cmd` 在线命令）：

```text
ap_cmd adev_tone 60 hs      # 播放测试音（hs 通路）
ap_cmd ob_dig_gain show
ap_cmd ob_dig_gain spk_hd 45   # 0 dB  → 0xBF
ap_cmd ob_dig_gain spk_hd 57   # +12 dB → 0xD7（cfg 默认）
ap_cmd ob_dig_gain spk_hd 63   # +18 dB → 0xE3（当前 / CLI 上限）
ap_cmd adev_tone stop
```

观察要点：把增益依次打到 63 → 57 → 45，音量应随之明显下降而非静音；配合 `ap_cmd es8389_regs` 记录每个增益档位的寄存器值与 `Vpeak`、听感。Line-out 侧对应的命令是 `ap_cmd adev_tone 60 lo` + `ap_cmd ob_dig_gain spk_lineout 45/57/63`；`ap_cmd hs_tone start|stop|gain 45` 用于手柄通路。

排查结论与注意点（已确认部分）：`spk_hd` 增益档位映射为 45→0xBF(0dB)、57→0xD7(+12dB)、63→0xE3(+18dB)，且 45 档只是显著变小、并非停止放音；CLI 上限为 63（若写入更大的值不会按预期线性增大）。

### MAC 清除流程确认（抓包 + 串口交叉验证）

**手段**：ATE 执行「MAC 清除」时同步抓包（`2.pcapng`）与保存串口日志（MobaXterm 115200 记录），再与 `legacy-repo` ATE 源码交叉比对。测试平台为 V62W（非 rk3506），但 ATE 协议与处理逻辑与 rk3506 代码库一致。

**时序还原（关键包）**：

| 方向 | 消息摘要 | 说明 |
|------|----------|------|
| 设备→PC | `msg=CR&cmd=connect&mac=<设备MAC>&id=0000000000000000&model=V62W&pid=6978...` | 设备主动连接并上报当前 MAC、ATE ID 未分配 |
| PC→设备 | `msg=RC&cmd=connect&result=success` | 连接成功 |
| PC→设备 | `msg=CR&cmd=set_id&id=277304595489106` | ① 写 ATE ID |
| PC→设备 | `msg=CR&cmd=write_mac&mac=000102030405&code=...&num=1&time=...` | ② 写默认 MAC（即清除） |
| 设备→PC | `msg=RC&cmd=write_mac&wifi_mac=<WiFi芯片MAC>&result=success` | 成功，回传 WiFi 芯片 MAC |
| PC→设备 | `msg=CR&cmd=factory_reset` | ③ 恢复出厂 |
| PC→设备 | `msg=CR&cmd=reboot` / `msg=CR&cmd=disconnect` | 收尾 |

**串口侧现象**：`write_mac` 阶段可见 CTRL 分区擦写（offset 0x0、0x20000… 交替 Erase/Write）；`factory_reset` 后出现 `default_user_config.txt not exist`，说明配置清除生效；重启后平台检测到默认/无效 MAC，打印 `set randdom mac:<随机值>` 自动生成临时 MAC 供网络使用。

**MAC 变化时间线**：

```
操作前:            已烧录的生产 MAC（原文档给出完整值）
write_mac 后(Flash): 00:01:02:03:04:05   ← 约定默认值，表示"已清除"
重启后:            平台生成随机 MAC       ← BSP 检测默认/无效 MAC 后自动生成
```

**结论**：清除 MAC 不是擦成全 0，而是写入约定默认值；MAC 存在 NAND CTRL 分区（`ota_WriteCtrlBlock`）；WiFi MAC 是芯片硬件地址、不被清除、仅回传；出厂重置主要清 `/userdata`，不清 CTRL 分区，MAC 清除靠 `write_mac` 完成。整体目的就是把设备恢复到「未烧录生产 MAC」的出厂态，以便重走 ATE 写号。

### 其它现场验证记录

- **分区/固件核对**：`check_partition.sh` 校验分区；用 `xxd` 抽取 `all-app-factory.bin` 的 ctrl 窗口 `[0x7F8000, 0x7FA000)`（8K，确认是否全 FF）、pid 所在 `sys_net @ 0x7FF000`（确认补丁在位、非全空），并用 `cmp` 对比修补前后的 `sysnet.bin`。
- **屏幕点亮命令**：`ap_cmd lcdtest black|clear|blink [1000]|stop`。
- **写 MAC 命令**：`ap_cmd mac -w eth <12 位 hex>`。
- **增益与寄存器**：`ap_cmd ob_dig_gain show`、`ap_cmd es8389_regs`、`ap_cmd hs_tone gain <n>`。

---

## 结论、注意事项与遗留问题

**可复用的既有结论**

1. 联机 ATE 的协议层（TCP 帧、报文 msg/action/result 语义、opt43 携带 `Vendor_ATE=<PC IP>:<端口>`、按键事件旁路）在 I12 与既有平台一致，I12-V2 的改造集中在「进入方式、测试项分支、单机入口、LED/音频硬件表」四块。
2. I12 的 LINE 测试不是独立命令，而是 `test_ip_call` 会话内的 path3；工装侧必须「音源进 line_in、从 line_out 听」，方向不可反，否则表现为无声（噪声门还会把底噪压成静音）。
3. 工厂联机失败的两个根因（ifname 读脏导致 opt43 hook 未安装、在非 tcpip 线程读 `netif_is_link_up` 导致 DHCP 不启动）与 CPU 绑核无关，修复方式是 global opt43 + `tcpip_callback` 内启动 DHCP。

**注意事项**

- path3 使能顺序不能颠倒：先起 I2S 主时钟，再配置 ES8389 line 通道，最后启 DMA/回环线程（ES8389 作 slave 依赖 MCLK/BCLK）。
- codec 增益用 0xBF（约 0dB），**不要用 0xFF**；`spk_hd` 档位 45/57/63 对应 0xBF/0xD7/0xE3。
- path3 期间必须 mute 板载 DAC，并关闭 SPK_AMP（path≠1 时 PA 应为关），否则会与 codec 混音、串音。
- `test_aging` 不允许从 TCP 路径启动，只回 `failed&reason=key_combo_only`，必须走单机速拨键。
- 扫频/老化规格中，单色 LED 的 29s+1s+30s 与双色 LED 每种颜色 1 分钟的节拍需实测确认。
- ATE 模式下 `factory_reset` 不自动重启，需 PC 单独下发 `reboot`。

**遗留 / 待确认**

- I12-V2 的 GPIO 表与 ADC 分压表在方案文档中仍是 `GPIO_XX` 占位，需硬件原理图确认后才能落地；温度门限、蜂鸣器 GPIO、USB 检测 GPIO 等 Kconfig 默认值同样待定。
- 实际 GPIO 现状（源自现场记录）：短路输入为 50、49；LED 调试用到 9/52/53/54；`GP28`→`GP48_AMP_EN`（后者为喇叭功放使能）。
- 单机 ATE 的 keycode 与 keymap 值需与实机 keymaps.txt 对齐（记录中的 `keymap[70]=15`/`[72]=16`/`[65]=13`、DSS3 keycode=65）。
- 进入时长的实现偏差（配置 5s，实测约 30s）需继续定位并收敛。
- `I12-V2_ATE.txt` 末尾为「修改之前：」，其后内容缺失（推测为截图或后续未抽取内容），本报告只归纳了该文档中确有文字的部分。

---

## 附：信息不足的源文件

| 源文件 | 情况 |
|--------|------|
| `I12-V2_ATE.txt`（由 `I12-V2_ATE.docx` 抽取） | 大部分内容为 `ap_cmd` 命令片段、寄存器/增益调试操作序列与实物接线说明，缺少上下文与结论；文末停在「修改之前：」，后续内容（推测为截图或未抽取部分）缺失，无法归纳为完整结论。本文仅采用其中确有文字且可独立理解的部分（编译命令、进入时长分段、keymap、音频实物对应、增益档位、分区检查）。 |

> 其余四份源文件均为结构完整的技术文档，信息充分。
