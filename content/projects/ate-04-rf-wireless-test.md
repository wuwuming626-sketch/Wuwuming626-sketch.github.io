+++
title = 'ATE-04 射频与无线测试（WiFi 耦合 / WiFi 联网 / BLE）'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 4
+++

我在查 PA1 的 WiFi 耦合时，`test_wifi_tx` 明明回了成功、IQ2010 却只读到约 -20.4 dBm，后来把探头对准 ANT-221 才复测通过；同机的 BLE 早期连接还要 65s。下面把 WiFi 耦合、联网、BLE 和经典蓝牙 RSSI 这几条链路完整记一遍。

> 覆盖内容：BK7258 平台 WiFi 耦合测试原理与协议、PA1 的 WiFi 联网与耦合落地、PA1 厂测 BLE、V50W BLE 链路验证，以及另一平台（SSD21x）经典蓝牙 RSSI 的 ATE 改造。
> 文中品牌统一写作「本司 / 厂商 / Vendor」，内网地址与个人目录已示例化。

## 概述

厂测中的无线测项按「是否需要真实热点」「是否经过空口」分为三类，混测会误判，必须分开查：

| 测项 | 命令 | 测什么 | 是否需要真实 AP |
| --- | --- | --- | --- |
| WiFi 联网 | `test_wifi` | STA 关联测试热点 + DHCP 拿 IP，再重连工装 | 需要 2.4G 热点 |
| WiFi 耦合 TX | `test_wifi_tx` | 指定信道/速率连续发射，仪表测功率/EVM/频偏 | 不需要 |
| WiFi 耦合 RX | `test_wifi_rx` | 仪表注入信号，DUT 统计 `rx`/`fcsErr`/`plcpErr` | 不需要 |
| BLE 透传 | `test_ble` | DUT 做 BLE 从机：可连接广播 + 固定 UUID 透传 GATT | 不需要（PC 蓝牙适配器走空口） |
| 经典蓝牙 RSSI | `test_bluetooth` 类 | 设备去扫指定 MAC 并读 RSSI 判范围 | 不需要 |

已核对的机型与状态：

- 支持 WiFi 联网 + WiFi 耦合：H2W（PID 3040）、V50W（PID 3039）——AP 侧 `CONFIG_WIFI_ENABLE=y`（本地栈）。
- 支持 WiFi 联网（VNET 路径）：H2U-V3（H2E）、V50E、V60E、PA1（PID 3024）等约 30 款。
- PA1 经改造后：WiFi 联网 + WiFi 耦合 + BLE 均可在厂测跑通。
- BK7258 仅 2.4G，信道 1～14，不支持 sub-1G 低功耗测项；AP 未开 5G 频段。

## 链路与协议

### 整机链路拓扑

```text
工装 PC
  │ ① 以太网 TCP + FF EE 帧：msg=TR / msg=RT
  ▼
DUT AP 核：ATE 协议解析 → WiFi/BLE 驱动 → PHY
  │ ② 空口耦合：耦合板 / 屏蔽箱 / 探头
  ▼
测试仪（IQ2010 / 综测仪）
```

- 控制面全部走网口 TCP；空口只承载被测的射频信号（耦合）或 BLE 业务（透传）。
- BLE 测项中，网口 TCP 只负责下发 `start`/`finished` 与回 `RT`（含 `mac`/`name`），不走蓝牙数据。
- 耦合测试不经过 STA 关联，与联网逻辑完全解耦。

### WiFi 耦合协议（TR / RT）

TX 启动与结束：

```text
msg=TR&cmd=test_wifi_tx&action=start&channel=7&rate=54&bandwidth=20&mode=802.11b
msg=RT&cmd=test_wifi_tx&status=start&result=success
msg=TR&cmd=test_wifi_tx&action=finished
msg=RT&cmd=test_wifi_tx&status=stop&result=success
```

RX 启动、周期推送与结束：

```text
msg=TR&cmd=test_wifi_rx&action=start&channel=7&bandwidth=20
msg=RT&cmd=test_wifi_rx&status=start&result=success
msg=RT&cmd=test_wifi_rx&status=start&rx=<N>&fcsErr=<N>&plcpErr=<N>   # 每 500ms 一条
msg=TR&cmd=test_wifi_rx&action=finished
msg=RT&cmd=test_wifi_rx&status=stop&result=success
```

要点：

- RX 无查询动作（没有 `action=get`），由设备按 500ms 周期主动推送；计数为**自 start 起累计**（start 打基线）。
- 失败原因码包括 `bad_channel` / `bad_rate` / `bad_len` / `bad_bandwidth` / `bad_greedfield` / `bad_action` / `wifi_tx_start` / `wifi_tx_stop` / `wifi_rx_stop`。
- TX/RX 互斥，不可同时跑；会话断开或 TCP 关闭触发 `force_stop`，避免 DUT 持续发射。

### TX 参数与速率映射

| 参数 | 含义 | 默认 | 备注 |
| --- | --- | --- | --- |
| `channel` | 信道 1～14 | 1 | 非法回 `bad_channel` |
| `rate` | 速率 | 54 | 见速率映射表 |
| `len` | 包长 | 0 | 0～8191，-1=auto；越界 `bad_len` |
| `bandwidth`/`bw` | 20/40 或 0/1 | 20M | `20→0`、`40→1` |
| `greedfield` | `GF`/`MF`（兼容 `MM`） | — | GF→`-f 3`，MF→`-f 2`；仅 HT 速率生效，传统速率忽略并告警 |
| `mode` | 工装标准名字符串 | 忽略 | 固件固定 `mac_bypass(1)`，与 PHY `-m` 语义无关 |

速率写入 `PHY -r` 的映射：`1/2/5.5/11`、`6/9/…/54`（可带 `M`）→ NON-HT（`5.5`→`5`）；`MCS0`～`MCS7` → `128`～`135`；`6.5/13/19.5/26/39/52/58.5/65` → `128`～`135`。

固件固定、工装不下发的 PHY 参数：`modul_format`（按 rate/greedfield 推导）、`power_mod`（固定 -1，走校准表）、`duty_cycle`（固定 90）。

### BLE 协议与 GATT 布局

| 项 | 值 |
| --- | --- |
| 广播名 | `{protocol_model}-BLE`（PA1 为 `PA1-BLE`） |
| 广播类型 | Legacy 可连接广播，31 字节 ADV（Flags + Complete Local Name） |
| 服务 UUID | `55535343-fe7d-4ae5-8fa9-9fafd205e455` |
| 写特征 TX（工装→设备） | `49535343-8841-43f4-a8d4-ecbe34729bb3` |
| 读特征 RX（设备→工装） | `49535343-1e4d-4bd9-ba61-23c647249616` |
| CCCD | `0x2902`，写 `0x0001` 开启 Notify |

- 这套 UUID 是门禁/对讲产线常见的透传布局，板上并不需要对应芯片；设备把写入 TX 的同一缓冲**原样 Notify** 到 RX，等价一根无线串口回显。
- 芯片 ATT 里 128-bit UUID 按小端存放，C 数组与上表自左向右互为反序，属正常现象。
- 工装硬条件：`RT&cmd=test_ble&status=start` 必须带 `mac` 与 `name`（只回 `status=start` 会立刻 FAIL）；空口能扫到该 MAC；GATT 能找到上述三组 UUID；写 TX 后短时间内收到 RX Notify。

### 经典蓝牙（BR/EDR）RSSI 链路

另一平台（SSD21x / V62W）走 Linux BlueZ + HCI Socket：

- 平台侧通过 `ateTestResult_t` 下发测试参数，结果需写回该结构体并由 `ateTestResultReport` 上报。
- 设备侧链路：`ateBluetoothStart()` → `EVT_BT_ATE_TEST` → `btAteTest(peer_mac, rssi_min, rssi_max, has_rssi_range)` → `btGetRssi()` → 结果经注册回调 `btAteResultNofify` 回填 `rssi`。
- 两种 RSSI 语义需区分：查询响应包里的 inquiry RSSI（无需连接、反映查询时刻强度、可能不是实时值）与 `hci_read_rssi` 读到的连接态实时 RSSI（需先建立 ACL/SCO 连接，更准确但更慢）。
- `hcitool scan --rssi` 亦可在扫描阶段拿到 RSSI；`bluetoothctl devices` 默认不显示 RSSI。

## 技术流程

### WiFi 耦合 TX 流程

```text
msg=TR&cmd=test_wifi_tx&action=start&channel=7&rate=54&bandwidth=20&mode=802.11b
  → 期望 RT: status=start&result=success
  → AP 日志: ate_wifi_rf: TX ret=0 ch=7 rate=54 ...
  → 仪表 ch7 出现功率/EVM 读数（非噪声底）
  → 等待仪表稳定（数百 ms～数秒，按工装流程）
msg=TR&cmd=test_wifi_tx&action=finished
  → 仪表功率回到噪声底；AP 日志: ate_wifi_rf: TX stop
```

HT 示例：`channel=7&rate=MCS0&bandwidth=20&greedfield=MF`。

软件侧判定 TX 启动成功的检查点：RT 为 `status=start&result=success`；AP 日志 `TX ret=0`；仪表在目标信道有功率。若 RT 回 `wifi_tx_start`：先看 `TX ret=` 是否非 0（`do_evm` 参数非法），再确认固件确实为本地 WiFi 栈（否则打 `no local wifi stack on AP`）。

仪表侧判定 TX「测试 OK」由工装/综测仪门限决定，典型项：信道频率对准、发射功率在规格窗内、EVM 达标、频偏在 ppm 规格内、占用带宽/邻道不超标。**软件 OK ≠ 射频 OK**：软件 OK 只表示已进入连续 TX。

### WiFi 耦合 RX 流程

```text
msg=TR&cmd=test_wifi_rx&action=start&channel=7&bandwidth=20
  → RT success，随后每 500ms 推送 rx/fcsErr/plcpErr
  → 仪表按目标功率注入固定包数/时长（工装控制）
  → 读累计计数
msg=TR&cmd=test_wifi_rx&action=finished
```

判定方式：

1. 通路 smoke：仪表打、耦合到位时 `R > 0` 且明显增加；未 start 时无周期推送属防护正常。
2. 灵敏度 / PER（量产）：`PER ≈ (fcsErr + 丢包) / 理论发分数`，在目标功率点判 `PER ≤ 门限`（如 10%）；可功率扫点画灵敏度曲线。
3. 错误计数合理性：高功率洁净信道下 `fcsErr`/`plcpErr` 应很低；降功率到门限附近时 `R` 下降、错误上升属预期。
4. 带宽一致性：`bandwidth=20` 读 `g_rxbw20`，`40` 读 `g_rxbw40`；带宽打错时 `rx` 可能几乎不涨。

注意 `plcpErr` 取自 PHY 的 PHYErr 计数，语义接近但需与仪表交叉确认。

### WiFi 联网流程（`test_wifi`）

```text
msg=TR&cmd=test_wifi&action=start&ssid=...&password=...
msg=RT&cmd=test_wifi&status=connecting
设备主动断开当前 ATE TCP → 连测试热点 → 等 IP
msg=CR&...&if=wifi        # 成功时，重连帧必须带 if=wifi
```

- 工装看到 `if=wifi` 才判 `test WiFi success`；仍从以太网重连则 FAIL。
- 实现只在 AP 开 `CONFIG_WIFI_ENABLE` 时走本地栈分支：`bk_wifi_sta_start` + **手动 `dhcp_start` + 轮询 `DHCP_STATE_BOUND`**（工厂 ATE 不走 NM，`EVENT_NETIF_GOT_IP4` 可能不发）；测前保存 STA 配置、测后恢复并把默认路由还回 ETH。
- 必须关闭 TX AMPDU（`bk_wifi_capa_config(WIFI_CAPA_ID_TX_AMPDU_EN, 0)`），否则 HardFault。
- 只用工装下发的 `ssid`/`password`，`security = WIFI_SECURITY_AUTO`；即使工装填了 5G 字段也不会单独切 5G。
- 厂测热点要求：**2.4G、WPA2-PSK、SSID 可见**。EAP/802.1X 企业网与证书路径未合入，办公网失败属预期；`link state=2`（STA DISCONNECTED）表示还没到 DHCP。

同一固件换热点对照（2026-09-02，PA1）：

| 时间 | SSID | 串口现象 | 工装 |
| --- | --- | --- | --- |
| 17:25 | `test` / `12345678` | `link connected` → DHCP → `if=wifi` | PASS |
| 17:27 | 企业办公网 SSID | `link state=2` 关联失败 | FAIL |
| 17:32 | 企业办公网 SSID | `wait link timeout` | FAIL |
| 17:41 | `test_2.4G_5G` / `123456789` | DHCP 拿到 IP → `if=wifi` | PASS |

`test_2.4G_5G` 能过只说明路由器双频同名、2.4G 那路开着且 PSK/DHCP 正常，**不等于设备走了 5G**。

### BLE 透传流程（`test_ble`）

```text
工装                              设备
  | TR&cmd=test_ble&action=start
  | ------------------------------>
  |   读 BT MAC → create_db → 挂起 sleep → BTPLL/IQ → 开广播
  | <------------------------------
  | RT status=start&mac=…&name=PA1-BLE
  | [空口] 扫描 → 连接 → 发现 GATT → 写 CCCD → 写 TX → 收 Notify
  | TR&cmd=test_ble&action=finished
  | ------------------------------>
  |   断 ACL → 停/删广播 → 恢复 RF vote / sleep
  | <------------------------------
  | RT status=stop
```

`start` 内部顺序（TCP 线程同步等到广播起来才回 RT）：

1. `bk_ate_mac_bt_read_hex12` 读 BT MAC（失败回 `reason=mac_read`，不开空口）；
2. `bt_ready()`（enable + controller ready；host FSM 忙则 `app_ble_reset`）；
3. `gatt_ensure()` → `bk_ble_create_db`，等 `BLE_5_CREATE_DB`；
4. 填 31 字节 Legacy ADV，广播名 `{protocol_model}-BLE`；
5. `pm_vote_hold` + `rf_iq_bounce`（BTPLL/IQ，测项期间关 WiFi RF vote）；
6. `bk_ble_create_advertising` → 回调里 `set_adv_data` → `start_advertising`（仅 create 成功才允许随后 delete）；
7. 成功回 `RT status=start&mac=&name=`。

写事件处理：CCCD 写入则记下订阅；TX 写入则拷到 RX，若 CCCD bit0 已置位立刻 Notify，回调内不做堆分配、不阻塞。`finished` 时工装往往还连着，须**先 `bk_ble_disconnect`，再停/删广播**，否则控制器仍占 activity 会导致 `stop_advertising` 失败。

未写 BT MAC 时设备默认地址常见为 `000102030405`（工装显示 `00:01:02:03:04:05`）。

### 经典蓝牙 RSSI 流程（SSD21x / V62W）

1. 平台下发 `ateBluetoothStart(param)`，取 `param->bluetooth.peerBTMac` 组事件；
2. `EVT_BT_ATE_TEST` → `btAteTest()`；
3. `btGetRssi()`：`str2ba` 转地址 → `hci_open_dev` → 已连接则直接取 `HCIGETCONNINFO`，未连接则 `hci_create_connection`，失败再退到 L2CAP（PSM `0x1001`）；
4. `hci_read_rssi(handle)` 取 RSSI，按 `rssi_min`/`rssi_max` 判范围；
5. 结果经注册回调上报，失败码区分 `BT_TEST_FAIL_MAC_MISMATCH` / `BT_TEST_FAIL_NO_RSSI` / `BT_TEST_FAIL_RSSI_OUT_OF_RANGE`。

实测耗时优化路径：保留扫描+匹配 → 匹配到即退出循环并建连，约 7～11s；再把扫描参数扫描时长由 5 降为 3，约 7s 内；最终去掉扫描、直接用已知 MAC 连接，约 5s 内。

平台侧接口约定：在 `ateTestResult_t` 中新增 RSSI 字段，设备侧把结果写入该结构体后经 `ateTestResultReport` 上报；设备侧只需改注册回调的传参与赋值处。

### 耦合测试架设与工装填写

- 耦合方式：天线接耦合板或整机进屏蔽箱，探头/仪表中心频率对准目标信道；TX 由仪表测功率/EVM/频偏，RX 由仪表注入已知功率信号。
- PA1 硬件：芯片自带 2.4G WiFi+BT，无外置 FEM（`WIFI_TX_EN` 等已 NC）。实际天线位号为 **ANT-221**，同处 IPEX 位号为预留不贴；走线为 `BK7258 ANT → R207(0Ω) → RFIN → ANT-221`，**耦合探头必须对准 ANT-221**。
- 工装通道/带宽填写：列表逗号个数要一致；只填 2.4G 信道 1～14；带宽 `0`/`20` 表示 20 MHz，`1`/`40` 表示 40 MHz；联调建议先全 20M，通道 `1,6,11`（或 `1,7,11`）。
- IQ 仪器日志（来自工装侧输出，非设备串口）：

```text
bModeTxTest=================<功率dBm>/<EVM dB>/B_freqErr=<频偏Hz>
```

第一个数是仪表口 TX 功率，不是 STA RSSI；界面显示 `9999` 多为失败占位，以 debuglog 为准。

## 调试过程记录

### PA1 WiFi 耦合不可用：VNET 架构（现象 → 根因 → 改动）

**现象**：`test_wifi_tx` / `test_wifi_rx` 返回失败，日志 `no local wifi stack on AP`；`test_wifi` 联网时 CP 侧 MemFault（`MMFAR=0x6`）。

**定位**：PA1 原为 VNET 架构——AP 为 `CONFIG_WIFI_VNET_CONTROLLER + PHY_CLIENT`，CP 为 `CONFIG_WIFI_ENABLE + PHY_SERVER`。ATE 跑在 AP，射频与 PHY 在 CP，AP 没有 `libbk_phy.a`，调不到 `do_evm`/`rxsens`；联网测试时 CP 的 `cif_thread` 回写 AP PSRAM 里的 `wdrv_cmd_buffer`，而 CP MPU 把 AP image 窗设为只读，触发 MemFault。

**结论与改动**：即使修 MPU，耦合项仍要求 AP 本地 PHY，因此一次性把 WiFi 迁到 AP 本地栈（对齐 V50W/H2W 模板），而不是继续修 VNET。未新增任何 `CONFIG_BK_ATE_*`，只打开 SDK 本地 WiFi 功能宏：

| 核 | 关键变化 |
| --- | --- |
| AP | `CONFIG_WIFI_ENABLE=y`；关 `PHY_CLIENT`/`PHY_MB`/`WIFI_VNET_CONTROLLER`；开 WPA、`STA_IP_NM_MANAGED`；core 栈 8192；文件尾补 `WIFI6_CODE_STACK`/`WIFI4`/`RWNX_SW_TXQ`/`VND_CAL`/`TEMP_DETECT` |
| CP | 关 `WIFI_ENABLE`/`PHY_SERVER`/`PHY_MB`/`WIFI_VNET_CONTROLLER` |
| Post | 关 `PHY_CLIENT`/VNET，不开 Post 维护 WiFi |

**验证**：迁栈后 AP 链接 `libbk_phy.a`，`bk_ate_wifi_rf.c` 实装生效；耦合 TX 日志出现 `ate_wifi: TX ret=0 ... power=-1`（`power=-1` 表示不走 `-p`、走校准表，正常）并回 `status=start&result=success`。

### 编译与链接四连坑

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `#error "At least one BA TX agreement shall be allowed"` | 产品 config 文件尾缺 `CONFIG_WIFI4=y`（`rwnx_config.h` 的 `CFG_BATX=5` 被 `#if CONFIG_WIFI4` 包住） | 把 `WIFI4`/`WIFI6_CODE_STACK`/`RWNX_SW_TXQ` 加回文件尾 |
| 链接缺 `tmp_pwr_tab` / 温度符号 | `CONFIG_VND_CAL`、`CONFIG_TEMP_DETECT` 默认 n | 显式打开；不要指望 Kconfig default 进产品 defconfig |
| `undefined reference to wifi_command` | `lfs_cli.c` 的 `wpacmd` 只 `#if CONFIG_WIFI_ENABLE`，而 PA1 无 `X_WIFI_SUPPORT`，不编 `bk_wifi_port.c` | 守卫改为 `#if CONFIG_WIFI_ENABLE && !CONFIG_BK_ATE_STANDALONE_PA1`，只裁 PA1；不要改用 `defined(CONFIG_LEGACY_APP_WIFI_BK_PORT)`（该宏在 `lfs_cli.c` 看不到，会导致所有机型都不编 `wpacmd`） |
| 扫描 `upload_cnt=0` / `rx_header_dma_dead` | DMA 缓冲落到 PSRAM | 见 4.3 |

### STA 连不上热点：MAC DMA 必须在片内 SRAM

**现象**：同一固件，有 SRAM 表时工装 PASS；删表后工装 FAIL（以太网重连、无 `if=wifi`）。

**定位**：`voip-project` 默认 `CONFIG_PSRAM_AS_EXECUTE_MEMORY`，普通 `.bss` 在 PSRAM，而 **WiFi MAC DMA 到不了 PSRAM**。链接脚本仅在 `CONFIG_AP_WIFI_DATA_SIZE > 0` 时才创建 `WIFI_DATA` 段并把 `libwifi.a` 的 `.bss` 放进去，该宏来自产品 `ram_regions.csv`。

**改动**：为 PA1 新建与 V50W 同尺寸的两份分区表（AP 与 Post/CP），新增 `AP_WIFI_DATA` 区，`AP_RAM` 与 `CP_RAM` 相应缩小，`CP_RAM` 起点必须与切分后一致且 512 对齐（不对齐会清掉 CP IRAM VTOR，静默起不来）。

| 区 | 工程默认 | PA1/V50W |
| --- | --- | --- |
| AP_RAM | `0x051800` | `0x048b00` |
| AP_WIFI_DATA | 无 | `0x024100` |
| CP_RAM | `0x03DF00` | `0x022b00`（512 对齐） |

**验证**：删表不是「脚本缺文件」，而是 DMA 缓冲落错地方导致 STA 连不上热点。SRAM 从 CP 划给 AP WiFi 后必须 clean 全编、AP+CP+Post 一起烧，只刷 AP 会分区错位。

### 联机闸门：`test_wifi` 断 TCP 后重连被丢弃

**现象**：`test_wifi` 下发后设备回 `connecting` 并关掉 TCP，之后工装再也收不到包，测项 FAIL。

**定位**：PA1 原逻辑（学 RM08）在「曾经连上但 `session_is_active()==0`」时退出联机并置 `s_tcp_allowed=0`，`test_wifi` 需要的重连被丢掉。

**改动**：对齐 V50E/V60E，`pa1_run_online()` 进联机后 `for(;;)` 保持闸门为 1，回单机需重启后长按 Reset；联机期间不扫 Reset（Reset 兼 test_led pass 键）。

**验证**：16:34 板上通过，工装收到带 `if=wifi` 的重连。

### 耦合 TX 软件通但 IQ 功率偏低（-20 dBm → PASS）

**现象**：`TX ret=0`、RT success，但 IQ2010（RF2，补偿 0）读到约 **-20.4 dBm**，低于当时 Min **-7 dBm**，工装判「发射不合格」。

**定位（对照实验）**：同一套工装 + 夹具上换 V50W，同样 `TX ret=0`、同样进耦合分支，IQ 读数约 **-24.5 dBm**，同样 FAIL。说明**不是** PA1 没带耦合代码、也不是 ATE 没下指令——指令都到了，IQ 也能稳定读数（不是一直 `-99999`）。问题指向**夹具/天线摆放与耦合位置、RF2 接线、补偿值**。

**改动/处理**：把探头对准 ANT-221（而非预留的 IPEX 位）并调整摆放后复测通过：

| 项 | 约值 | 当时门限 |
| --- | --- | --- |
| ch1/7/11 发射功率 | -8.4～-8.9 dBm | Min -20 dBm |
| EVM | -18.8 dB | Max -10 dB |
| 频偏 | -2.6～-3.2 kHz | ±40 kHz |
| RX 灵敏度 ch1 | PER 3.24% | Max 10% |

**验证结论**：相对早先 -20 dBm 强了十几 dB；本次未补线损，-8 dBm 仍是仪表口读数；产线合格常见为补偿后的正数功率。`tempd detect failed` 与本司 RC 无回复两条日志与耦合成败无关。

### PA1 BLE：扫不到 / 连接与 Notify 慢

**现象（早期，同一工装）**：扫描约 0.7s、连接约 65s、连接到 Notify 约 29s，整项近两分钟仍可能 PASS；串口刷 `cp1 wait cp0 vote sleep[8] time out`。

**定位与改动**：

1. **空口看不见（HCI 却正常）**：未切 BLE IQ。对齐 CLI `blescan`，测项期间执行 `rwnx_cal_set_rfconfig_BTPLL()` + `ble_enter_iq_mode()`，打开 BLE RF vote 并关掉 WiFi RF vote。
2. **连接/GATT 发现被拖住**：`[8]` 是 BTSP 睡眠投票，协议栈被拖。测项期间 `bk_pm_sleep_vote_suspend()`，`finished` 时 `resume`；只包住 `test_ble`，不包 `test_bluetooth`。
3. **GATT 建表**：固件 BLE Host 为 RW 旧栈，建表是一次交表的 `bk_ble_create_db()`，不是 `gatt_db_add_*`；拿错 API 会 `CMD_NOT_SUPPORT`，运行时若 host 栈类型非预期直接失败。`prf_task_id = 11`，避开 boarding 占用的 10。
4. **`create_db` 异步失败可同电重试**：同步失败（未置 `issued`）直接再调；已发出但 4s 超时则保持 `issued` 等迟到回调；回调 status≠0 时清 `issued/fail` 允许重建；成功则保持 `s_gatt_ready` 直接返回。
5. **`finished` 收尾**：先 `bk_ble_disconnect` 再停/删广播。

**验证（Alpha2.8.6）**：扫描约 0.1～0.4s、连接约 2s、连接到 Notify 约 1s，数秒内 PASS；设备侧日志应见 `gatt create_db ok prf=11`、`adv start name=PA1-BLE`、`restored WiFi RF vote`、`RT status=stop`，测项进行中不应连续刷 `sleep[8]`。同电再跑 `test_WiFi`（STA+DHCP）也实测 PASS；耦合 TX/RX 未在同电接在 BLE 之后验证，当前产线顺序是网口 → BLE → WiFi 联网。

### V50W BLE 链路验证（11 项全通过）

改动：AP 配置打开 `CONFIG_BLUETOOTH_AP=y`、`CONFIG_BLE=y`、`CONFIG_BLUETOOTH_AUTO_ENABLE=y`（AP 本地 controller+host，`HOST_ONLY`/`IPC` 保持关闭）。验证方式为 CLI（需 `ap_cmd` 前缀）+ 串口日志，出厂 `LOG_LEVEL=1` 时临时改 3 取详细日志，验证后回退并重编。

关键结果：

- 栈就绪：`bt_status=1 ctrl_ready=1 host_fsm=1 host_stack=2 rf_en=1`；开机 `app_bt_init()` 自动初始化成功，无 bluetooth 错误。
- 蓝牙 MAC = 以太网 MAC + 1。
- 扫描：`blescan start` → 8 秒 `reports=2992 notices=2993`，样例包含 `rssi=-71 type=9 addr=... len=31`；`blescan stop` 状态清理正常。
- 广播：`bleadv start` → `adv cmd=1/2/4 status=0` → `BLE ADV started (name <MODEL>-BLE)`，运行时 `adv=0` 保持；`bleadv stop` 正常。
- RF 共存：广播时 `air hold: BLE open, WiFi RF closed`，停止后 `restored WiFi RF vote`。
- 无回归：进 xui、网络 UP、双核心跳正常。

未覆盖项（源报告列出的建议）：手机第三方扫描工具交叉验证空口可见性、GATT 连接/服务发现/大包交互、扫描与广播启停 20 次以上压测、WiFi iperf 打流下的共存吞吐、连续断电重启 5 次稳定性。

### V62W 经典蓝牙 RSSI：从「扫描匹配」改为「直连」

**现象**：ATE 测试要判 RSSI 是否落在工装给的范围内，但平台侧原先没有蓝牙 RSSI 字段可用（只有 433 有）；实测 `范围 -10~0 没通过`、`-19 成功`、`范围 0~0 时 -17`、`范围 -70~50 时 -21 不在范围内`；时序上出现 8s 连上但不在范围、20s 没匹配上目标蓝牙、9s 未获取到 RSSI、3s 获取到 等不稳定记录。

**定位**：

1. 结果通路缺失——需要在 `ateTestResult_t` 中新增 RSSI 字段，设备侧把值写入该结构体后用 `ateTestResultReport` 上报，即改注册回调的传参与赋值。
2. 平台蓝牙能力确认：`bluetoothd --version` 为 BlueZ 4.101，`hciconfig -a` 显示 `Type: BR/EDR`（非 BR/EDR/LE），`hcitool le` 不支持，配置中 GATT 被禁用 → **该平台蓝牙为经典蓝牙（BR/EDR），BLE 不可用**。
3. RSSI 获取方式选择：经典蓝牙可在「发现设备」阶段从查询响应包拿到 RSSI，也可在连接后读连接态实时 RSSI；前者不需连接但可能非实时，后者更准但需先建连。工装判范围用的是单值，连接态取值更稳定。

**改动**：`btGetRssi()` 用 HCI 接口直接连接并读值——`str2ba` → `hci_get_route`/`hci_open_dev` → `HCIGETCONNINFO`（已连则直接取句柄，未连则 `hci_create_connection`，失败退到 L2CAP PSM `0x1001`）→ 等 50ms～1s → `hci_read_rssi(handle)`；`btAteTest()` 拆分 MAC 列表（最多 3 个）、逐个取值、按 `index`/`flag` 与 `rssi_obtained` 归一化判定，回 `BT_TEST_FAIL_MAC_MISMATCH` / `BT_TEST_FAIL_NO_RSSI` / `BT_TEST_FAIL_RSSI_OUT_OF_RANGE`。

```c
if (flag == index) {
    if (rssi_obtained) {
        if (has_rssi_range) {
            if (rssi_value >= rssi_min && rssi_value <= rssi_max)
                gBtAteResultCb(OK, (int16_t)rssi_value, BT_TEST_FAIL_OTHER);
            else
                gBtAteResultCb(ERROR, (int16_t)rssi_value, BT_TEST_FAIL_RSSI_OUT_OF_RANGE);
        } else {
            gBtAteResultCb(OK, (int16_t)rssi_value, BT_TEST_FAIL_OTHER);
        }
    } else {
        gBtAteResultCb(ERROR, 0, BT_TEST_FAIL_NO_RSSI);
    }
} else {
    gBtAteResultCb(ERROR, 0, BT_TEST_FAIL_MAC_MISMATCH);
}
```

**耗时优化（三版对照）**：① 保留扫描匹配但匹配到即退出循环并建连，约 7～11s；② 再把扫描时长参数由 5 改为 3，约 7s 内；③ 去掉扫描匹配、直接用已知 MAC 连接，约 5s 内（最终版）。另外把 HCI 设备的打开/`HCIDEVUP` 提到 `btAteTest()` 里统一做，`btGetRssi(dd, addr, &rssi)` 复用句柄。

**收尾问题**：改动后存在换行符导致的补丁问题，用编辑器定位到目标行替换为 `btAteTest(evt.info.str, evt.info.rssi_min, evt.info.rssi_max);` 后再提交。

## 结论、注意事项与遗留问题

### 结论

1. WiFi 耦合能否落地只取决于 **AP 侧是否有本地 WiFi 栈 + PHY 库**；协议层是产品共用的，不需要按型号写 if/else。VNET 机型（含原 PA1）架构上不可用耦合项，必须迁栈。
2. 耦合 TX/RX 的软件判据与射频判据分离：软件只保证「按参数开启发射/开始接收并计数」，功率/EVM/频偏/PER 必须由仪表门限裁定。
3. PA1 的关键改动是四块缺一不可：本地栈配置、SRAM 分区表（`AP_WIFI_DATA`）、联机闸门、`lfs_cli.c` 守卫；改完 clean 全编三核同烧。
4. BLE 测项的本质是「可连接广播 + 固定 UUID 透传 GATT + 写后 Notify」；扫不到、连得慢几乎都指向 IQ/RF vote 与睡眠投票，而不是 GATT 表本身。
5. 经典蓝牙 RSSI 在 BlueZ 平台上可用 HCI 直接取值；把「扫描匹配」换成「已知 MAC 直连」是耗时优化的最大收益点（约 2 倍以上）。

### 注意事项

- 耦合调试第一步先分清测项：耦合失败不要先查联网逻辑，联网失败不要先查 `txevm`/`rxsens`。
- 手工旁路验证（PA1 当前默认未编 `txevm`/`rxsens` CLI，`WIFI_CLI` 关且 `CLI_CFG_PHY=0`）：TX 用 `txevm -m 1 -c 7 -b 0 -r 54 -w 0`，RX 用 `rxsens -s 1 -c 7 -b 0` → `rxsens -g 1` → `rxsens -s 0`。手工无功率先查校准/天线/硬件，手工有功率而 ATE 无则查参数映射。
- 正常库 `libbk_phy.a` 的 `rxsens -s 1` 只清统计不起收；`CONFIG_ATE_TEST=n` 时必须补一次 `rs_test(channel, IEEE80211_BAND_2GHZ, bandwidth)` 才真正起收，stop 用 `rs_deinit()`。若改为链接 ATE 产测库，这段直调需重新评估。
- 日志速查（AP 侧，TAG `ate_wifi_rf`）：`TX ret=`/`TX stop`、`RX start ret=`/`RX get`/`RX stop ret=`、`force TX stop`/`force RX stop`、`no local wifi stack on AP`。
- 非 HT 速率下 `non-HT rate=1, ignore greedfield=GF` 属正常，不是失败。
- 产线建议顺序：网口 → BLE → WiFi 联网；耦合 TX/RX 尚未在同电接在 BLE 之后验证。

### 遗留问题

- 工装目前不下发定频（`-w`）、占空比（`-y`）、晶振微调（`-x`）等参数，固件按默认值拼 argv；后续工装需要时可在 TR 增加解析并填入已有 `bk_ate_wifi_tx_param_t` 字段（argv 拼装处已预留）。
- 耦合实测的功率门限在不同时间记录中出现过 Min -7 dBm 与 Min -20 dBm 两种值，尚未对齐；线损补偿值也需产线标定后固化。
- EAP/企业认证与证书路径未合入，`test_wifi` 只覆盖个人热点 PSK。
- V50W BLE 的第三方交叉验证、GATT 连接、反复启停压测、WiFi 打流共存、断电重启稳定性均未测。
- PA1 耦合 RX 只在 ch1 有 PER 实测值，其余信道与其他速率点未覆盖。

## 附：信息不足的源文件

- `ATE蓝牙rssi.txt`：为过程记录/聊天式笔记，含大量片段（如「113」「手机」「范围是 0-0 时」「新烧录」「没修改之前」等），缺少上下文，无法确定其对应的具体测试条件与结论；另含大段通用的跨平台（Windows/Linux/Android）蓝牙 RSSI 能力说明，与本司 ATE 改动无直接关系，未纳入正文。
- 其余 5 个源文件信息完整，均已通读并归纳。
