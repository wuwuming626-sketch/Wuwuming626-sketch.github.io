+++
title = 'ATE-07 批量升级与 OTA 链路'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 7
+++

上位机一句话「update」，机器就得自己跑去 FTP 把包拉回来——AP 先写 CTRL 凭证，Post 再下载刷写。两边的交接只要有一处对不上，整条批量升级线就会卡在原地，一声不吭。这条链路我走了不止一遍，下面照实记。

## 概述

### 背景

`voip-project` 工程（机型 H2E / H2U-V3）原先已支持网页 OTA：用户在 Web 上传 `.z` 升级包，AP 阶段 1 把参数写入 CTRL 分区后重启进 Post，由 Post 完成阶段 2 的 Flash 写入。

产测（ATE）场景下，设备已能通过网口与 ATE 上位机（工装 PC）按工装协议交互。为避免人工插 U 盘或访问网页，需要让上位机直接下发升级指令，设备从指定 FTP 服务器下载升级包并完成一次等效于网页升级的 OTA。

### 目标

- 上位机在 ATE 等待界面下发 `update` 指令，携带 FTP URL、用户名、密码、文件名；
- 设备自动从 FTP 下载 `.z` 包，走与网页升级完全等效的 OTA 流程；
- 升级完成后自动重启回 AP，并重新进入 ATE 模式向上位机上报结果；
- 结果只上报一次，不兜底重试，避免无限循环；
- 支持批量、连续作业：升级后不得残留状态导致下一台/下一轮误入恢复路径。

### 关键约束

1. 协议格式复用现有工装协议，上位机侧不新增解析逻辑；
2. 升级包必须与网页升级一致（`.z` 包，内部为 `fv_bk_ota` section 格式）；
3. FTP 使用被动模式 PASV；整包先 staging 到 PSRAM，再按 section 写入 Flash；
4. 双核分工：AP 负责接收 ATE 指令与持久化参数，Post 负责 FTP 下载与 OTA 写入；
5. 结果上报只尝试一次，无论成功失败都在发送后清除持久化标志；
6. 不引入“AP 启动成功确认”或“自动回滚”新机制，AP 起不来的场景沿用既有 watchdog/复位行为；
7. AP→Post 网络需要交接：`fv_net_handoff_capture_ap` + `commit`，让 Post 快速恢复工装网段。

### 设计文档的两版差异（事实记录）

源目录中存在两份同名设计文档，后者为修订版，主要差异如下：

| 项目 | 早期版（2026-07-03） | 修订版（0706） |
| --- | --- | --- |
| CTRL sector 1 偏移 | `0x0200` | `0x1000`（4KB sector） |
| `pending_target` 初值 | `CP` | `NONE` |
| `upgrading` 应答 | `msg=RC&cmd=update&result=upgrading` | 增加 `type=sys` 字段 |
| 约束条数 | 6 条 | 7 条（补充 AP→Post 网络 handoff） |
| 上位机配套要求 | 无 | 新增整章“上位机软件要求” |

---

## 链路与协议

### 三方链路

整体是“工装上位机 ↔ 设备（AP / Post） ↔ FTP 服务器”三段式：

```
上位机 ──TCP──> AP ──reboot──> Post ──reboot──> AP ──TCP──> 上位机
                │               │
                └─ 写 CTRL 凭证 ─┘   Post 另经 FTP(PASV) 从服务器拉 .z
```

- 上位机与设备：TCP 长连接，工装协议文本报文（`msg=CR/RC&key=value`）；
- AP 与 Post：不直接通信，只通过 CTRL 分区（Flash）传递凭证、boot 标志与结果；
- Post 与 FTP 服务器：独立网络栈 + PSRAM 缓冲，做整包下载。

### 报文与字段

| 报文 | 方向 | 说明 |
| --- | --- | --- |
| `msg=CR&cmd=update&type=sys&url=...&user=...&password=...&file=...` | 上位机→设备 | 下发升级，仅接受 `type=sys` |
| `msg=RC&cmd=update&type=sys&result=upgrading` | 设备→上位机 | 参数校验通过、CTRL 写入成功后才回 |
| `msg=CR&cmd=disconnect&reason=upgrading` | 设备→上位机 | 设备即将断开并重启 |
| `msg=RC&cmd=update&result=success&reason=...` | 设备→上位机 | 升级结果上报（重连会话内） |
| `msg=RC&cmd=update&result=failed&reason=...` | 设备→上位机 | 失败上报 |
| `msg=CR&cmd=connect&id=...&mac=...&model=...` | 设备→上位机 | 普通连接（首次进 ATE） |
| `msg=CR&cmd=connect&id=...&type=reconnect` | 设备→上位机 | 升级后重连汇报，仅此场景带 `type=reconnect` |

参数约束：`type` 必须为 `sys`，否则直接回 failed；`url`、`file` 必须存在且格式合法；`user`/`password` 可缺省，缺省按匿名 FTP 处理。

失败 `reason` 取值集合（源文档出现过的）：`invalid_type`、`busy`、`bad_param`、`disabled`、`ota_fail`。

### DHCP / option 43 / type=reconnect 三者的区别

这三者常被混淆，源笔记专门做了区分：

- **DHCP**：网卡拿 IP，工厂网能起来；
- **option 43**：DHCP 应答里的厂商选项，内含 `Vendor_ATE=<工装IP>:<端口>`，设备靠它知道连哪台工装；
- **type=reconnect**：设备连上工装后首帧 `msg=CR&cmd=connect` 里的可选字段，告诉工装“这是升级后重连汇报，不是普通首次进 ATE”。

关键点：`dhcp`/`option` 不是 connect 报文字段，它们属于“怎么找到工装并连上”的过程；`type=reconnect` 才是 connect 报文里带的。

### CTRL 分区布局与 boot_flag 位掩码

CTRL 分区 8 KB，修订版布局：

| Sector | 偏移 | 内容 |
| --- | --- | --- |
| 0 | 0x0000 | 8 字节 ctrl blob：`magic` + `cp_written` + `boot_flag` + `pending_target` + `ota_result` |
| 1 | 0x1000 | JSON 凭证 / URL（`url`、`user`、`pwd`，可扩展 `reason`），4KB sector |

`boot_flag` 由单字节枚举改为位掩码，这是整条链路的判据基础：

```c
#define FV_BK_OTA_CTRL_BOOT_RECOVERY      (1 << 0)   /* 原 BOOT_RECOVERY */
#define FV_BK_OTA_CTRL_BOOT_ATE_RECONNECT (1 << 1)   /* ATE 升级后自动重连 */
```

语义：`RECOVERY` = “留在 Post 继续刷”；`ATE_RECONNECT` = “回 AP 后要不要进 ATE 汇报”。两者独立置位/清除，设置 `RECOVERY` 时必须用 `|` 保留已存在的 `ATE_RECONNECT`。

配套新增：位掩码 `FV_BK_OTA_CTRL_BOOT_FLAG_MASK`，两个内联判断 `fv_bk_ota_ctrl_boot_has_recovery()` / `fv_bk_ota_ctrl_boot_has_ate_reconnect()`，以及 API `fv_bk_ota_ctrl_set_ate_upgrade_boot()` 与 `fv_bk_ota_ctrl_clear_ate_reconnect()`。

### CP/AP 双核通信链路（BK7258）

BK7258 为三核 SoC：CPU0 为 CP 核（通信处理器，跑 WiFi/BLE 协议栈），CPU1+CPU2 为 AP 核（FreeRTOS SMP，跑用户应用）。两侧独立固件镜像，经硬件 Mailbox 通信。分层如下：

| 层 | 组件 | 要点 |
| --- | --- | --- |
| 硬件 | MBOX0 | 3 通道，FIFO 深度 CP=2 / AP core0=3 / AP core1=3，中断驱动，通道与核心硬绑定 |
| 适配层 | `mbox0_adapter.c` | 提供 `bk_mailbox_*` API，数据不直穿 FIFO，改走共享内存 |
| 逻辑通道 | `mailbox_channel.c` | 16 个逻辑通道在一条物理通道上复用，优先级调度，CMD/ACK 协议 |
| IPC | `mb_ipc.c` | socket 风格：`socket/connect/send/recv/disconnect/close` |
| RPC | `bk_api_rpc_client.c` | 远程过程调用，如 AP 调 CP 取芯片 UID |

FIFO 消息体与共享内存传参方式：

```c
typedef struct {
    uint8_t  src_cpu;
    uint8_t  dest_cpu;
    uint32_t data[2];   /* data[0]=共享内存地址, data[1]=长度(或命令 ID) */
} mbox0_message_t;
```

- ISR 中 `data[1] != 0` → 正常 mailbox 消息，走 `rx_callback`；
- ISR 中 `data[1] == 0` → SMP 跨核调度命令（`crosscore_smp_cmd_handler`，yield/suspend 等）。

逻辑通道 ID 编码（8-bit）：

```
bit[7:6] = 目标 CPU ID (0~3)
bit[5:4] = 源 CPU ID   (0~3)
bit[3:0] = 逻辑通道索引 (0~15)
```

CMD 走 `MB_PHY_CMD_CHNL`（BOX0），ACK 走 `MB_PHY_ACK_CHNL`（BOX1）。逻辑通道临界区用 spinlock + 关中断保护，保证 SMP 安全。

IPC 端口按 CPU 分工：CP 侧提供 `FLASH_SERVER` / `SARADC_SERVER` / `PHY_SERVER`，AP 侧对应 `*_CLIENT`。CP 无法直接访问 Flash，Flash 操作由 AP 作为 Client 通过 IPC 代理到 CP 的 Server 完成。

CP 启动地址来自 Flash 分区 `BK_PARTITION_APPLICATION1`，AP 计算物理地址后写入寄存器：

```c
uint32 addr = get_partition_addr(1);
sys_drv_set_cpu1_boot_address_offset(addr >> 8);
sys_drv_set_cpu1_reset(1);   /* 释放复位，CP 开始执行 */
```

---

## 技术流程

### AP 侧：收到 `update` 后的持久化与重启

入口在 ATE 报文分发（`bk_ate_vendor_msg.c` 的 `cr_dispatch()`）的 `update` 分支，改为调用新模块 `bk_ate_upgrade.c`。`bk_ate_upgrade_start()` 的核心步骤：

1. 解析 `url` / `type` / `file` / `user` / `password`（`get_param()` 手写 `&key=value` 解析，无标准 URL 库）；
2. 校验 `type == sys`；
3. `build_ftp_url()` 拼接完整 FTP URL（`url` 目录 + `file`）；
4. 应答：PC early 模式立即回 RC success；标准模式回 `RC upgrading` + `CR disconnect reason=upgrading`；
5. 关闭 ATE TCP 会话；
6. 写 CTRL：`fv_bk_ota_ctrl_set_ate_upgrade_boot()` → `boot_flag = RECOVERY | ATE_RECONNECT`，`pending_target = NONE`，`ota_result = IN_PROGRESS`；
7. `handoff_ap_net()` 保存网络状态给 Post；
8. 写 CTRL sector 1 的 FTP 凭证 JSON；
9. 异步 `schedule_reboot()`。

**注意执行顺序**：修订后的顺序是「先写 boot flag → 再 handoff → 最后写 URL」，而不是先写 URL 后写 boot flag。原因见第 4.4 节。

于是开机时判据为：`fv_cp_boot_should_jump_ap()` 见到 `RECOVERY` → 留在 Post，且**只清 `RECOVERY`**、保留 `ATE_RECONNECT`，此时 CTRL 变为 `boot_flag = ATE_RECONNECT` + `IN_PROGRESS` + URL 仍在。

CTRL 凭证 JSON 示例（地址、账密已脱敏）：

```json
{
  "url": "ftp://10.0.0.10/firmware/H2U-V3-1.1.1-new_r-T20260615115013.z",
  "user": "ftpuser",
  "pwd": "******"
}
```

### Post 侧：FTP 下载 + OTA 写入

入口复用既有自动更新函数 `post_autoupdate_download_z_from_ctrl()`；`post_boot` 里通过 `post_autoupdate_download_z_from_ctrl_kickoff()` 在独立线程（8KB 栈）非阻塞启动。当 CTRL 中 `ota_result != SUCCESS` 且 URL 非空时进入下载。

FTP 下载流程：

1. 从 CTRL sector 1 读 `url`/`user`/`pwd`；
2. `au_ftp_parse_url()` 解析 `ftp://host:port/path`，端口默认 21；
3. 建控制连接并登录；
4. 发 `PASV` 进被动模式；
5. 发 `SIZE <path>` 取文件大小；
6. 建数据连接，`RETR` 下载整包到 PSRAM staging 区（约 13 MB，地址 `0x60300000` 附近，与网页 OTA 一致）；
7. 下载完成关闭 FTP 连接。

写入路径按 URL 协议分流，FTP 与 HTTPS 走各自实现：

- `ftp://` → `au_ftp_stream_z()`（回调 `au_ftp_retr_cb()` 逐块喂入 OTA pipeline，`au_ftp_feed()` 先解析 `.z` 包头 64 字节确定总大小）；
- 其他 → `au_https_stream_z()`（依赖 `CONFIG_HTTPS`）。

OTA 写入使用 `fv_bk_ota_stream_*` API 按 section 解析并写 Flash，完成后调用 `fv_bk_ota_try_jump_ap_or_reboot()`。

结果持久化（成功/失败都做）：`ota_result = SUCCESS/FAILED`，`pending_target = NONE`，**保留 `ATE_RECONNECT`**；失败原因写入 sector 1 JSON 的 `reason` 字段。

ATE 路径下的额外处理：`post_ate_upgrade.c` 提供 `post_ate_upgrade_ctrl_active()`（判断是否 ATE 路径）、`post_ate_upgrade_on_ota_failed()`（写 FAILED 后立即 reboot 回 AP，不重试）、以及禁用 short-body 重试的判定。

### 回 AP 后的两条分支

**成功（默认路径）**

1. Post 的 `reset_clean()` 写 `SUCCESS`、清 URL，只保留 `ATE_RECONNECT`；
2. 回 AP 后 `bk_ate_boot_probe_upgrade_reconnect()` 读到 `ATE_RECONNECT` + `SUCCESS`，直接 `clear_ate_reconnect()` 并 `return 0`；
3. 结果：不强制进 ATE、不发 `type=reconnect`、不再二次上报 success。

**失败**

1. `post_ate_upgrade_on_ota_failed()` → `set_result(FAILED)` + `bk_reboot()`，`ATE_RECONNECT` 仍在（此时一般已无 `RECOVERY`、`pending` 多为 `NONE`）；
2. 再开机无 pending、无 RECOVERY → `should_jump_ap` 为真，进 AP；
3. AP `boot_probe`：有 `ATE_RECONNECT` 但结果非 SUCCESS → 置 `s_connect_reconnect=1`、`s_report_pending=1`，强制进 ATE；
4. 若当时是 `IN_PROGRESS` 残留，先规范化为 `FAILED`；
5. 重新 DHCP → 取 option 43 → 连工装，connect 带 `type=reconnect`；
6. `bk_ate_upgrade_on_session_ready()` 读到 FAILED，发 `RC update ... result=failed&reason=ota_fail`；
7. `upgrade_report_finalize()` 清 URL 并 `clear_ate_reconnect()`。

注意：失败路径下早期已发出的 early success 与最终 failed 可以并存（工装先看到 success，后看到 failed）。

### 掉电/中途重启的路径矩阵

断电后只看 Flash 当时的状态，由 `fv_cp_boot_should_jump_ap()` + Post kickoff / AP `boot_probe` 决定走向：

| 断电时的 CTRL 状态 | 再上电进哪 | 会不会继续升 | 会不会带 `type=reconnect` |
| --- | --- | --- | --- |
| 已写 `RECOVERY\|ATE_RECONNECT` + URL，未进过 Post | Post | 会（整包重新下载，非断点续传） | 暂不会，最终成功/失败再定 |
| 已进 Post（`RECOVERY` 已清）、仅剩 `ATE_RECONNECT` + `IN_PROGRESS`、无 pending | AP | **否**（不会回 Post 续升） | 会，`IN_PROGRESS`→`FAILED` 后报 failed |
| Stage1 已完成 `set_cp_pending()`（`pending=CP` + `RECOVERY`） | Post | 会（按 stage2 逻辑刷 AP） | 暂不会 |
| 已 `reset_clean()` 成功、尚未清标志 | AP | 否 | 否（early 分支直接清标志） |

代码层面的定论：

1. `ATE_RECONNECT` 只表示“回 AP 后是否要走 ATE 汇报”，**不表示“继续 OTA”**；
2. “继续 OTA”的充分条件是进了 Post 且 `download_z_from_ctrl` 看到 URL 且结果非 SUCCESS，此时整包重拉；
3. `type=reconnect` 只在 AP `boot_probe` 置了 `s_connect_reconnect` 后，由会话 connect 报文带上。

### CP↔AP 双核启动与心跳流程

CP 核启动链路（AP 侧先动）：

```
AP: components_early_init() → bk_pm_mailbox_init() → pm_cp1_mailbox_init()
AP: main() → start_cpu1_core()
       ├── sys_drv_set_cpu1_pwr_dw(0)            上电
       ├── sys_drv_set_cpu1_boot_address_offset() 设置启动地址
       ├── sys_drv_set_cpu1_reset(1)              释放复位
       └── mb_ipc_reset_notify(1, 1)
CP: entry_main() → rtos_init() → components_early_init() → start_app_main_thread() → WiFi/BLE init
CP: rtos_start_scheduler()
CP→AP: IPC_CPU1_POWER_UP_INDICATION（启动完成）
CP→AP: IPC_CPU1_HEART_BEAT_INDICATION（周期心跳）
```

心跳判断存在两个方向，需要分开理解：

- **AP 侧监控 CP 存活**：CP 周期发 `IPC_CPU1_HEART_BEAT_INDICATION`，AP 侧心跳任务超时未收到则重启 CP 核（重新 `start_cpu1_core()`）；
- **CP 侧判断 AP 存活**：原机制依赖 AP 周期发送的“专用 heartbeat 包”，本次扩展为“专用 heartbeat 包 **或** AP 主动发来的有效 mailbox RX CMD 包”都可作为存活证据（详见第 4.9 节）。

主要 IPC 命令（系统管理类）包括：`IPC_CPU1_POWER_UP_INDICATION`、`IPC_CPU1_HEART_BEAT_INDICATION`、`IPC_GET/SET_CPU1_HEART_RATE`、`IPC_RES_ACQUIRE/RELEASE_CNT`、`IPC_ALLOC/FREE_DMA_CHNL`、`IPC_CPU1_TRAP_HANDLE_BEGIN/END`、`IPC_CPU1_NEED_REBOOT`、`IPC_CPU0_START/STOP_USB_CDC`。

---

## 调试过程记录

本节按「现象 → 定位手段 → 根因 → 修改 → 验证结论」归纳各源文档中记录的问题。

### `update` 指令只回桩响应，未真正升级

- **现象**：上位机下发 `CR cmd=update` 后，设备只回一个占位响应，固件并未升级。
- **定位手段**：查 ATE 报文分发分支，确认 `update` 分支实现为直接返回 `result=upgrading&reason=stub`。
- **根因**：功能从未实现，只有占位桩。
- **修改**：新增 `bk_ate_upgrade.c`（约 541 行）实现完整状态机；`cr_dispatch()` 的 `update` 分支改为「busy 检查 → `bk_ate_upgrade_start()`」，并区分失败原因 `busy`、`bad_param`、`disabled`。整次提交共改动 22 个文件，+1227/-46 行。
- **验证结论**：源文档未附实测记录，仅列测试要点（见第 5 节）。

### 上位机约 4 秒 Ping 超时误判升级失败

- **现象**：设备收到 update 后立刻断开并重启，工装上位机在 `disconnect upgrading` 后约 4 秒因 Ping 不通终止流程，判为失败。
- **定位手段**：对照上位机行为（依赖 Ping 连通性判活）与设备重启期间的网络断连时间窗。
- **根因**：标准流程的“`RC upgrading` + `CR disconnect` + reboot”会让设备在 Post 阶段长时间不可达；旧版上位机（如 Alpha2.0.1.18）不支持“等待重连”语义。
- **修改**：新增兼容开关 `CONFIG_BK_ATE_UPGRADE_PC_EARLY_SUCCESS`（默认 y），收到 update 后**立即**回 `RC success`，让上位机把该台判为通过；设备侧真实结果仍以 Post 写入的 `ota_result` 为准。
- **验证结论**：文档给出的是取舍结论——代价是成功路径不再二次汇报；失败场景仍会通过 `type=reconnect` 报 failed。上位机侧若要支持标准流程，需改为“收到 disconnect 后进入等待重连、停止 Ping 判失败、等待超时 ≥120s”。

### `boot_flag` 为单值导致 `ATE_RECONNECT` 被误清

- **现象**：ATE 升级后回 AP，AP 无法识别需要重连汇报；或清除恢复标志时把重连标志一起清掉。
- **定位手段**：检查 `boot_flag` 的所有读写点，发现多处是“精确等于”比较与“整体赋 0”。
- **根因**：`boot_flag` 是单字节枚举（0/1），无法同时表达“进 Post 恢复”和“回 AP 重连上报”；`boot_flag = 0`、`== BOOT_RECOVERY` 这类写法会连带破坏另一个语义。
- **修改**：
  - `FV_BK_OTA_CTRL_BOOT_RECOVERY` 改为 `(1U << 0)`，新增 `FV_BK_OTA_CTRL_BOOT_ATE_RECONNECT = (1U << 1)` 与掩码；
  - Ctrl 层 `normalize_in_memory()` 校验从 `> 1U` 改为按掩码过滤；`reset_clean()` / `set_cp_pending()` / `set_post_ota_boot()` 全部改为位操作保留 `ATE_RECONNECT`；
  - CP 层 `cp_boot_jump.c`：`boot_flag == RECOVERY` 改为 `fv_bk_ota_ctrl_boot_has_recovery()`；清除由 `boot_flag = 0` 改为 `boot_flag &= ~FV_BK_OTA_CTRL_BOOT_RECOVERY`。
- **验证结论**：以位测试替代精确比较后，两个标志可独立设置/清除、互不干扰（设计结论）。

### 写入顺序不当造成“孤立 URL”与重启失败后的状态残留

- **现象**：升级启动阶段写 CTRL 失败时，下一次普通重启可能误入 ATE 恢复路径；或 URL 已落盘但没有任何升级标志。
- **定位手段**：梳理 `bk_ate_upgrade_start()` 三条失败出口（URL 写入失败、reboot 调度失败）与当时的 CTRL 内容。
- **根因**：
  1. 旧顺序是“先写 URL 凭证 → handoff → 后写 boot flag”，若 boot flag 写入失败，会留下“有 URL、无升级标志”的孤立状态，难以恢复；且 `handoff_ap_net()` 已执行，网络已切到 Post 侧而升级未启动，状态不一致；
  2. reboot 调度失败时旧代码只 `return`，不清理 boot flag 和 URL，下次普通重启会被误判为需要 ATE 升级。
- **修改**：
  - 顺序调整为「先 `fv_bk_ota_ctrl_set_ate_upgrade_boot()` → `handoff_ap_net()` → 再写 URL 凭证」，这样即使 URL 写入失败，Post 也能看到 ATE 标志并上报错误；
  - 新增 `rollback_ate_upgrade_boot_flag()`：清除 `RECOVERY | ATE_RECONNECT`，并把 `ota_result` 重置为 `NONE`、`pending_target` 重置为 `NONE`；
  - URL 写入失败、reboot 调度失败两条路径都调用回滚；reboot 失败时额外 `ctrl_cred_clear()` 清凭证。
- **验证结论**：以“失败出口必须把 CTRL 恢复成干净状态”为收敛条件；该轮改动共 6 个文件 +140/-31 行。

### 升级过程反复擦写 CTRL 的掉电窗口

- **现象**：ATE 批量升级会反复用相同内容调用 CTRL 写入接口，每次都触发一次 4KB sector 擦除 + 写入。
- **定位手段**：跟踪 `fv_bk_ota_ctrl_commit()` 与 `fv_bk_ota_ctrl_write_url()` 的实现路径。
- **根因**：erase 是破坏性操作，若在 erase 与 write 之间掉电，该 sector 数据永久丢失；而多数调用写入的内容与 Flash 现值完全一致，属于无谓擦写。
- **修改**：两个接口都加“先读、再比对、相同则直接返回 `BK_OK`”的短路逻辑：

```c
uint8_t current[FV_BK_OTA_CTRL_ON_DISK_SIZE];   /* 8 字节 */
if (bk_flash_partition_read(ctrl_part, current, 0, sizeof(current)) == BK_OK &&
    memcmp(current, wire, sizeof(wire)) == 0) {
    return BK_OK;   /* Flash 已是目标值 → 跳过擦除+写入 */
}
```

  URL 写入侧额外要求“剩余字节全为 0（zero-padded）”才算命中；该实现复用 `static` 的 1KB `url_buf` 先作读缓冲再作写缓冲，不额外增加静态内存。
- **验证结论**：掉电风险窗口从“每次调用都存在”缩减为“仅在内容需要变更时存在”（设计结论）。

### Post 侧重复读 Flash 与冗余判断

- **现象**：Post 启动路径中，LCD 显示、OTA kickoff、autoupdate 三条路径各自调用 `post_ate_upgrade_ctrl_active()`，每次都会 `fv_bk_ota_ctrl_read()` 读一次 Flash；`post_autoupdate_z.c` 内多个判断点同样各自调用。
- **定位手段**：统计 `post_ate_upgrade_ctrl_active()` 的调用点数量。
- **根因**：缺少缓存，单次启动最多 3 次（`post_boot.c`）+ 4 次以上（`post_autoupdate_z.c`）重复 Flash 读。
- **修改**：
  - `post_boot.c`：把 `ate_active` 提升到函数顶层，只读一次，下游（LCD / OTA kickoff / autoupdate）统一复用；
  - `post_autoupdate_z.c`：函数入口缓存一次 `ate_active`，FTP 失败、HTTPS short-body 重试、清理凭证、下载失败等判断点统一改用它；
  - `post_ate_upgrade.c/.h`：删除 `post_ate_upgrade_skip_short_body_retry()`，并从 `post_ate_upgrade_on_ota_failed()` 内移除重复的 `post_ate_upgrade_ctrl_active()` 检查，改由调用方保证前置条件。
- **验证结论**：单次启动的 CTRL Flash 读由多次收敛为 1 次。

### Windows FTP 服务器 PASV 应答 IP 不一致导致数据通道失败

- **现象**：从 Windows FTP 服务器下载 `.z` 时数据通道连接失败。
- **定位手段**：检查 PASV 应答中的 IP 与控制连接实际对端 IP 是否一致（多网卡/NAT 场景）。
- **根因**：PASV 应答携带的 IP 可能与控制连接 IP 不同，设备按应答 IP 建数据连接会失败。
- **修改**：在 `ftp_client.c` 新增 `ftp_pasv_use_control_host()`，用 `lwip_getpeername()` 取控制连接对端 IP 覆盖 PASV 应答 IP，并在 `ftp_client_retr()` 的 PASV 解析后调用。
- **验证结论**：源文档未附实测数据，仅记录该兼容处理。

### Post 下载阻塞启动流程

- **现象**：CTRL 凭证下载原为阻塞调用，会拖慢 Post 启动（ATE 路径下还伴随不必要的 LCD 屏显）。
- **定位手段**：检查 `post_boot.c` 中下载调用与 UI 调用的时序。
- **根因**：下载函数在 Post 启动主路径上同步执行。
- **修改**：保留 `post_autoupdate_download_z_from_ctrl()` 为实际执行函数，新增 `post_autoupdate_download_z_from_ctrl_kickoff()` 在独立线程（8KB 栈）中调用；`post_boot.c` 改调 kickoff 版本，并在 ATE 路径跳过 `post_show_post_mode_screen()`。
- **验证结论**：Post 启动不再被下载阻塞（设计结论）。

### CP 侧心跳误判 AP 超时

- **现象**：AP 未发送专用 heartbeat 包，但仍在通过 mailbox 发送其他有效业务消息时，CP 仍可能判定 AP heartbeat 超时。
- **定位手段**：梳理修改前 CP 侧 heartbeat 刷新路径，确认只有专用 heartbeat 包会刷新时间戳。
- **根因**：heartbeat 判断与 mailbox 实际通信活跃度脱节——普通 mailbox CMD 包、CP 请求对应的 RX ACK 都不被当作 AP 存活证据。
- **修改**：引入“mailbox RX 活跃序号”：

```
AP 主动发送 mailbox CMD 包
  -> CP mailbox IRQ 收包
  -> 校验目标 CPU、source CPU、logical channel index
  -> 通过则记录 RX 活跃序号变化（不唤醒 task、ISR 内不取时间、不打日志）
  -> 仍按原 mailbox 业务流程分发/回 ACK

heartbeat task 检查
  -> power off：直接认为未超时
  -> starting / dump：刷新 timestamp
  -> 活跃序号变化：刷新 timestamp，本轮未超时
  -> 序号未变化：仍按原 timestamp 超时逻辑判断
```

  “有效 mailbox RX CMD 包”的判定条件：目标 CPU 是当前 CP、非 self 包、source CPU 合法、logical channel index 合法。RX ACK 路径明确不计入。该机制用 `mb_ipc_heartbeat.c` 内的本地宏控制并默认开启，宏关闭时不编译该逻辑、`mailbox_channel.c` 的 hook 退化为空实现，行为回退为只依赖专用 heartbeat 包。状态切换（power off / power on / starting / 直接进入 supervise on）都需要先同步活跃序号 baseline，避免旧序号在新一轮启动中被误当续命证据。
- **验证结论**：给出 8 条待验证场景（专用 heartbeat 正常时不应超时；停 heartbeat 但持续发有效 mailbox CMD 不应超时；全部停止应正常超时；power off 后残留包不应长期续命；power off→on 后旧记录不应误续命；高频 CMD 不应导致 task 高频唤醒；越界 channel index 不应续命；只有 RX ACK 时不应续命）。源文档只列验证要点，未附实测结果。

### `IN_PROGRESS` 残留状态的规范化

- **现象**：升级过程中断电，重启后 CTRL 里 `ota_result` 仍是 `IN_PROGRESS`，可能被误当成“仍在升级”。
- **定位手段**：按断电时刻的 CTRL 组合逐一推演再上电路径（见 3.4 矩阵）。
- **根因**：`IN_PROGRESS` 是过渡态，没有对应的“重启后重新接管”机制；AP 这条路径不会回 Post 继续升级。
- **修改**：`bk_ate_boot_probe_upgrade_reconnect()` 在检测到 `ATE_RECONNECT` 且结果非 SUCCESS 时，把 `IN_PROGRESS` 规范化为 `FAILED`，置重连标记后强制进 ATE 上报，随后清标志。
- **验证结论**：该路径不会回 Post 续升（即使 URL 仍在，AP 也不会去 FTP 续传）；失败只上报一次，避免无限重连。

---

## 结论、注意事项与遗留问题

### 结论

1. 链路本质是“AP 落盘一句话，Post 干活，AP 再挂一次号”：AP 只负责把 FTP 凭证与 boot 标志写进 CTRL 并重启，下载与刷写全部在 Post，结果再通过 CTRL 传回 AP。
2. `RECOVERY` 与 `ATE_RECONNECT` 必须按位独立管理，任何“整体赋值”“精确等于”的写法都会破坏语义。
3. 成功路径不二次汇报，失败路径才重连上报；工装侧“以为成功”靠 early success，设备侧“是否真成功”只认 Post 写的 `ota_result`。
4. 失败的收敛原则是“只报一次、不兜底重试”，避免批量升级出现无限循环。
5. CP/AP 心跳从容错角度做了增强：把“AP 主动发的有效 mailbox CMD”也当作存活证据，但仍保持 ISR 轻量（不取时间、不 set event、不打日志）。

### 注意事项

- 上位机若按标准流程（`upgrading` + `disconnect`）实现，必须改为“进入等待重连、停止 Ping 判失败”，等待超时建议 ≥120s；否则应开启 early success 兼容开关。
- CTRL 各类写入都应保持“内容不变则跳过擦写”的短路逻辑，缩小 erase 与 write 之间的掉电窗口。
- 升级启动阶段的失败出口必须回滚 boot 标志与凭证，否则会在下一次普通重启时误入 ATE 恢复路径。
- `type=reconnect` 只在升级后重连会话出现；普通首次连接不带该字段。
- 掉电续升的判据是“是否还带 `RECOVERY`/`pending`”，而不是 URL 是否存在。

### 遗留问题

- 源文档只给出测试要点，未附实测数据与结论，以下场景仍需真机验证：合法 update 全流程成功、非法 `type` 直回 failed、FTP 不可达/文件不存在时上报 failed 并带 reason、OTA 中掉电不无限重连、升级成功后普通启动不再进 reconnect 模式；以及第 4.9 节列出的 8 条心跳场景。
- 不引入 AP 启动成功确认与自动回滚是既定约束；若固件头正常但 AP 运行期崩溃，仍依赖既有 watchdog 复位行为（现有 CP 在搬运 AP 固件前只校验固件头 CRC、版本、`load_addr`、`decompressed_size` 与 LZMA payload 完整性）。
- 上位机侧（如 Alpha2.0.1.18）在 `disconnect upgrading` 后约 4s 判失败的实现，与服务端标准流程不匹配，文档标注为“需上位机侧修改”，尚未闭环。
- `post_autoupdate_z.c` 的 FTP/HTTPS 分流后，HTTPS 分支仍受 `CONFIG_HTTPS` 编译条件约束，配置组合的覆盖情况源文档未说明。

---

## 附：信息不足的源文件

无。7 个源文件均含有效技术内容，全部纳入本总结。

需要说明的两点：

1. `2026-07-03-ate-ftp-ota-design.md` 与 `0706-ate-ftp-ota-design.md` 内容高度重复，后者为修订版；本总结以修订版为准，两版差异已在第 1.4 节列表说明。
2. `ATE批量升级.md` 为问答式原始笔记，无标题层级，内容已被归纳进第 2.3 节与第 3.3、3.4 节。
