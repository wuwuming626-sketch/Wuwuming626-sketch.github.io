+++
title = 'USB与存储-01 U 盘检测与插拔稳定性'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 4
+++

插一次没事，插两次没事，插着插着它忽然就翻脸——T134088 这类「待机下多次插拔就异常」的毛病，最折磨人的地方在于它从不给你一个干脆的失败，只是偶尔装作不认识这张盘。U 盘检测、消抖、挂载升级、虚拟串口，MB12、I12、V67、A330 几台机器轮着来。下面把这条链路记一遍。

## 概述

本文汇总 USB 设备（U 盘、USB 虚拟串口模块）在 **Host 侧** 的检测、消抖、枚举、挂载、升级与读写相关流程与调试记录，覆盖两条产品线：

| 平台 | 控制器 / 协议栈 | 相关产品 |
|------|----------------|----------|
| BK7258 + RTOS | CherryUSB + MUSB（Naneng PHY） | MB12、I12 等 |
| RK3506 / RK3576 + Linux | Linux usb-core + DWC2（Inno USB2 PHY） | V67；A330（Android 侧） |

贯穿全文的一条主线是：**「线上有没有设备」「这次算不算一次 USB 连接/断开」「这个盘/这个口能不能给应用用」是三层不同的结论**，分别由电气层、Hub（或等价 Host 状态机）与业务层（挂载/属性）给出。把这三层混为一谈，是插拔类问题的常见根因。

本文只归纳两类内容：

1. **技术流程**：USB 检测/枚举/去抖机制、复位与枚举期间的抖动处理、U 盘挂载与升级、文件系统操作、串口 TTY 读写。
2. **调试过程**：现象 → 定位手段 → 根因 → 修改 → 验证结论。

边界说明：所依据的源文件全部是 **Host 模式**（插 U 盘、插 USB 串口模块、U 盘升级）；OTG 切 Device、USB 耳机/WiFi、Type-C CC 等 **gadget（设备侧）** 内容在源文件中没有实现细节，本文不展开、也不推测。

按惯例，本文对厂商名、人名、内网地址、个人目录与设备唯一标识做了统一占位化处理；产品型号、芯片型号、内部问题单号、代码路径与函数名（除品牌词）保留。

---

## 模块结构与关键路径

### BK7258（RTOS / CherryUSB + MUSB）

| 文件 | 角色 |
|------|------|
| `ap/components/bk_usb/CherryUSB/port/beken_musb/usb_hc_beken_musb.c` | **核心**：根口状态机（want/gen/quiet/Reset 假断/HOLD/tick/限次恢复）、电气态判定、控制器静默 |
| `ap/components/bk_usb/CherryUSB/class/hub/usbh_hub.c` | 枚举与断开处理、消抖（`DEBOUNCE_TIMEOUT`/`DEBOUNCE_TIME_STEP`）、root 特判、线程 500ms 收队 |
| `ap/components/bk_usb/CherryUSB/core/usbh_core.c` | `usbh_initialize()` 透传 hub 初始化失败 |
| `ap/components/bk_usb/CherryUSB/driver/usb_driver.c` | `bk_usb_phy_register_refresh()`（软重配）、`bk_usb_open()` 失败回滚 |
| `ap/include/components/cherryusb/usb_hc.h`、`usbh_hub.h` | 根口状态机对外 API、`usbh_roothub_thread_send_queue()` 返回 `int` |
| `ap/components/fatfs/ff.c`、`ffsystem.c`、`disk_io.c` | FatFS 挂载/卸载、同步对象回收、物理盘初始化/反初始化 |
| `ap/components/fatfs/test_fatfs.c`、`ap/components/bk_cli/cli_fatfs.c` | `fatfstest` CLI（M/S/U/R/W）与卸载实现 |
| `projects/qemu_voip/ap/cli_usb_dpdn_demo.c` | 应用层 U 盘服务（`udisk_svc`）、mount/unmount 回调、GPIO |
| `projects/qemu_voip/config/products/mb12-v2/ap/config/bk7258_ap/usr_gpio_cfg.h` | GPIO 配置（EN / FLAG） |

### Linux / RK（DWC2 + usb-core + 业务层）

| 文件 | 角色 |
|------|------|
| `bsp/kernel/drivers/usb/dwc2/hcd.c` | HCD connect/disconnect 标志、`GetPortStatus`、`SetPortFeature(RESET)` |
| `bsp/kernel/drivers/usb/dwc2/hcd_intr.c` | `dwc2_port_intr()`（`HPRT0.CONNDET` 端口中断） |
| `bsp/kernel/drivers/usb/dwc2/core_intr.c` | `dwc2_handle_disconnect_intr()`（`GINTSTS.DISCONNINT`） |
| `bsp/kernel/drivers/usb/dwc2/hw.h` | `HPRT0_CONNSTS/CONNDET/ENA/ENACHG/RST` 定义 |
| `bsp/kernel/drivers/usb/core/hub.c` | `hub_irq()`/`hub_event()`/`hub_port_connect()`/`hub_port_debounce()`/`hub_port_wait_reset()` |
| `vendor_app/xapp_resource/etc/udisk.sh` + `buildroot/package/busybox/mdev.conf` | 块设备 `add`/`remove` → mount/umount → 属性 |
| `vendor_app/xapp_2/src/hardware/usb_detect.c`、`hardware.c`、`vendor_app/vcore/vcore/dm/src/dmUsb.c` | 属性监听、上报 DM、状态去重 |
| `drivers/usb/serial/option.c` | USB 串口 option 驱动的 `option_ids` 表（VID/PID 白名单） |

### Android（A330 / RK3576 U 盘升级）

`RKRecoverySystem` / `RKUpdateService` / `RecoverySystemService` / `UpdateEngine`（A/B）与 `SystemUpdate` 预装应用构成两条升级路径；相关源码落点：`system/update_engine/payload_consumer/delta_performer.cc`（时间戳检查）、`update_engine/common/error_code.h`（错误码）。

---

## 技术流程

### 三层「结论」的分工

| 问题 | BK7258（MUSB） | RK/Linux（DWC2） |
|------|----------------|------------------|
| 线上有没有设备（电气） | PHY + MUSB `IS.CONN`/`IS.DISCON` | PHY + `HPRT0.CONNSTS` |
| 刚发生插/拔（边沿） | `IS.CONN`(0x10) / `IS.DISCON`(0x20) 两个独立位，同一拍 DISCON 优先 | `HPRT0.CONNDET`（插拔共用变化位）+ `GINTSTS.DISCONNINT` |
| IRQ 此刻想连还是想断 | 修前是 `port_pe`；修后是 `want`（`s_root_want_conn`） | ISR 直接写 `port_connect_status` / `_change` |
| **这次算不算 USB 连接/断开** | Hub `usbh_hub_events()` 消抖之后 | `hub_port_connect()` 消抖之后 |
| **这次算不算盘可用** | MSC 回调 + `udisk_svc` mount | `usb-storage` → mdev → `udisk.sh` mount 成功 + 属性 |

两个平台一致的事实：**检测由 PHY + 控制器完成，软件不扫 D+/D-；机械 GPIO 不参与 USB 判定**。MB12 上 GPIO21（`USB_FLAG`）只是状态脚，GPIO20（`USB_EN`）只用来开 VBUS；两侧的 U 盘插拔都不依赖 GPIO。

电气判据：设备把 D+（FS/HS）或 D-（LS）拉高即 CONN；D+/D- 回到 SE0 并超过控制器/PHY 的断开时间即 DISCON。**这是线态/Session 断开，不是关掉 5V**（Host 口 VBUS 保持供电，否则无法再检测插入）。PHY 侧还有自己的 SE0 断开时间（微秒级硬件滤波），与后面软件 100ms/200ms 量级的消抖不是一回事。

BK 侧初始化时还把 PHY 断开阈值写成约 640mV（`NANENG_PHY_FC_REG0B = 0x7C`），并在中断使能里打开 `RESET | CONN | DISCON | RESUME | SUSPND | BABBLE | SESREQ | VBUSERR`。

### 消抖：从「超时看最后一拍」到「连续稳定」

**BK 初版 Hub 消抖**（`usbh_hub.c`）常量 `DEBOUNCE_TIMEOUT=400`、`DEBOUNCE_TIME_STEP=25`、`DELAY_TIME_AFTER_RESET=20`：

- 每 25ms 读一次 `GetPortStatus`（读的是软件位 `port_pe`，不读 `IS`）；
- 触发那一拍不计入稳定数；`CONNECTION` 连续为 1 满 4 拍提前结束（约 100ms 量级）；
- **断开不加计数、不提前退出**，通常跑满 400ms，最后按最后一拍决定连还是断；
- 消抖后再走「复位 20ms + 松 20ms → 再等 20ms → 读一次状态」，看到 ENABLE 才 `usbh_hub_events_connect_handle()`。这段 20ms 是复位恢复时间，不是第二轮消抖。

**Linux 规范 Hub 消抖**（`hub_port_debounce()`）：

```c
#define HUB_DEBOUNCE_TIMEOUT    2000  /* 最长等 2s */
#define HUB_DEBOUNCE_STEP         25  /* 每 25ms 读一次 */
#define HUB_DEBOUNCE_STABLE      100  /* 必须连续稳定 100ms */
```

`hub_port_connect()` 用的是 `hub_port_debounce_be_stable()`（`must_be_connected=false`）：**稳定在「连」或稳定在「断」都可以结束**。一旦出现 `C_CONNECTION` 或 `CONNECTION` 翻转，`stable_time` 清零重启；2s 内凑不满连续 100ms 则 `-ETIMEDOUT`，本次不当连上（日志 `connect-debounce failed`）。依据是 USB 2.0 §7.1.7.3：检测到连接后、发复位前至少 100ms。

关键差异：Linux **只看 `CONNECTION` 位**，没有 BK 侧「用 `HSMODE/FSDEV/LSDEV` 速度位把假断开打回 CONN」这种纠错；毛刺让 `CONNSTS` 掉了，就按断开重启 100ms 窗口。

### 根口状态机：意图与落地分离（BK7258）

修前问题：IRQ 每条 CONN/DISCON/BABBLE 边沿都立刻改 `pe/CSC` 并入队，抖动被当成多次真插拔；Reset 期 SE0 打出假 DISCON 把 `want/pe` 清掉；对空端口发 RESET 得到 `Failed to enable port 1` 刷屏；枚举失败路径对 PHY/时钟上下电导致 CPU 挂死；失败即清 want 导致「盘还插着却再也认不到」。

修复设计四件事：**意图与落地分离、电气判定、消抖、分级恢复**。

1. **IRQ 只记意图**（`usbh_musb_root_port_request()`）：Reset 窗内（`!want && s_root_in_reset`）忽略 disconnect 意图；已空闲的重复 DISCON（`!want && !want_conn && !pe`）直接忽略；真插拔边沿清零全部预算（soft/last-resort/HOLD/enable-retry）并重新武装 last resort；临界区内只改标志，入队（`usbh_musb_root_enqueue_apply()`）放在区外，入队失败回滚 `pending`。
2. **apply 消抖后落地**（`usbh_musb_root_port_apply()`，hub 线程内）：先等安静窗口 `ROOT_QUIET_MS`（200ms，`gen` 变化即重新计时，总上限 `ROOT_QUIET_TOTAL_MAX_MS`=2s）；之后三分支 —— 真拔（`want=0` 且安静后仍 0）直接 disconnect；安静未达成则软断开并 **保留 want 进入 HOLD**；安静达成且 `pe && enum_ok` 视为会话健康，只清残留端口事件。
3. **Reset 挡假断 + 等 HSMODE**（`usbh_reset_port()`）：置 `s_root_in_reset`、清 `pe`；最多 `ROOT_RESET_ATTEMPTS`（3）轮 RESET（20ms 置位 + 20ms 清除），每轮后每 5ms 采电气态、最多 100ms；出现 HS/LS 立即跳出，三态全无重发，**仅 FSDEV 视为歧义态继续重发**（慢 HS chirp 盘若按 FS 上报会导致 hub 用全速配置 EP0 → 整段 `-116`/ETIMEDOUT）；最后只有 `want` 且电气存在（`usbh_musb_root_elec_present()`）才置 `pe=1`。
4. **电气四态判定**（`usbh_musb_root_elec_state()`）：`MUSB_POWER.HSMODE`→HS；`MUSB_DEVCTL.LSDEV`→LS；`MUSB_DEVCTL.FSDEV`→FSDEV；否则 NONE。
5. **分级恢复**（`usbh_musb_root_try_requeue_recover()`）：soft 软重连（清 pe/enum_ok、置 CSC/PEC、重新入队 apply）≤1 次 → last resort（`bk_usb_phy_register_refresh()`，仅控制器/自定义寄存器软重配）→ soft 确认 ≤1 次 → 预算耗尽：电气全无则清 want，不在 HS 视为粘滞假电气清 want，仍在 HS 则进 HOLD。**刻意不做 VBUS 脉冲硬救，也不再额外 `register_init`**。
6. **HOLD + tick 自愈**：`usbh_musb_root_enter_hold()` 只设 hold 与到期时间、清本轮预算、保留 want；hub 线程由永久阻塞改为 **500ms 超时收队**，超时调 `usbh_musb_root_tick()`：若 `hold && want && !pe` 且退避到期，先确认电气仍在，再置 CSC/PEC 重新入队 apply（日志 `root HOLD retry connect`）。退避区间 1s→2s→4s，截顶 5s。
7. **关键不变量**：`want` 只有三个清除出口 —— 真拔（apply 路径）、电气上确无设备（`clear_want_idle` 的 no elec 分支）、预算耗尽且端口不在 HS（粘滞假电气）。避免出现「盘还在却按拔掉处理」。

配套收紧：`bk_usb_phy_register_refresh()` 语义收窄为 `usbh_musb_controller_quiesce()`（清 `MUSB_IE`/IS/TXIS/RXIS、停 SESSION、重建 PHY 断开门限）+ 自定义寄存器设置 + `usb_hc_mhdrc_register_init()`；原因是 **Host 运行中关掉 USB 时钟/电源域后，CPU 再访问 MUSB 寄存器会直接挂死**（实测都停在枚举失败这一步）。

### 复位/枚举期间的抖动谁处理

| | BK（修前/修后） | Linux（DWC2） |
|--|------------------|----------------|
| 复位期间处理插拔吗 | 修前不处理，只入队；复位结束强制 `port_pe=1`，本轮几乎总会去枚举 | `hub_port_wait_reset()` **当轮**自己 `GetPortStatus`，不必等下一轮 `hub_event` |
| 断开 | 积压的 CONN/DISCON 等整轮 `usbh_hub_events()`（含枚举）返回后逐条再消抖 | `CONNECTION=0` → `-ENOTCONN`，`hub_port_reset()` 立刻停重试、`hub_port_connect()` 不再枚举，disable 端口 |
| 仍连着但有变化位 | 排队等待 | 返回 `-EAGAIN`，**再发一次复位，不回到 100ms 消抖**，最多 `PORT_RESET_TRIES`（默认 5） |
| 复位完不成 | — | `-EBUSY`，重试用尽后日志类似 `Cannot enable. Maybe the USB cable is bad?` |

重试层数（Linux）：`hub_port_connect` 最多 4 轮枚举 → `hub_port_init` → `hub_port_reset` 最多 5 次 RESET → `hub_port_wait_reset` 最多 800ms。半程失败时还会给口掉电再上电一次；**只有 `-ENOTCONN`/`-ENOTSUPP` 才直接退出**。

枚举过程中线断掉时的两条路：硬件上仍是同一颗 `DISCON` 边沿，但软件分成两条路径 —— 一条是 Hub 的状态位（修前 BK 因为 hub 线程正堵在 `usbh_control_transfer()` 里，处理不到），另一条是**本次控制传输失败**（EP0 报 ERROR/NAKTO，或等满 500ms 超时）。所以「先传输失败、后处理 DISCON 状态」，两者同源但时序不同。

### U 盘挂载：FatFS 层流程（BK7258）

- **挂载**：`f_mount()` 入口先 `ff_flush_pending(vol)` 回收上一轮残留；注销旧同步对象；`find_volume()` 内部 `lock_fs → disk_initialize → 解析 BPB`。
- **卸载**：`f_unmount(pdrv, path, opt)` 先 `disk_uninitialize(pdrv)`，再 `f_mount(NULL, path, opt)` 注销卷。**`opt` 必须为 0**：`opt=1` 会让 `f_mount` 在卸载后立刻 `find_volume` 重找卷，此时 `fs` 为 NULL，错误分支里 `clear_lock(fs)` 访问空指针偏移 `0x18` → MemFault。
- **物理盘反初始化**：`disk_uninitialize()` 对 `DEV_USB` 分支原实现只 `break`，`stat` 仍是 `RES_ERROR`，导致 `f_unmount` 恒返回 `FR_DISK_ERR(1)`；修后在校验 `CONFIG_USB_HOST && CONFIG_USBH_MSC` 时置 `stat = RES_OK`。
- **同步对象回收**：`ff_del_syncobj()` 删前查持有者（`xSemaphoreGetMutexHolder()`），自己持有则先 Give 再删，他人持有返回 0 交调用方暂存；`f_mount` 删不掉时移入暂存位 `ff_pending_del[]`，下轮入口回收；`find_volume` 失败分支必须**先 `unlock_fs` 再删对象**，否则触发 `vQueueDelete` 断言。
- **CLI 层**：`fatfstest` 支持 `M/S/U/R/W`（盘号 2 一般是 U 盘）；`S 2` 会递归列目录、易触发 `fr=18`；`W` 命令在只给 5 个参数时此前 `content_len` 未赋值，导致写入 0 字节。

### U 盘业务层：两种「第二结论」

**BK（`cli_usb_dpdn_demo.c` 的 `udisk_svc`）**：状态量 `alive / want_mount / seq / mounted / unmounting`，读写全在临界区内；挂载前与注册铃声路径后都用 `stale = (!alive || seq != snap || !want_mount)` 校验，序号变了补做卸载；卸载以 `mounted/unmounting` 防并发，**先 VFS 卸载成功再注销 ring**，失败保留 mounted 标志。

**Linux（mdev + 脚本）**：`mdev.conf` 把 `sd[a-z].*` 的 `add`/`remove` 交给 `/etc/udisk.sh`：

```
add:    设备名长度==3（整盘 sda）→ 先 sleep 0.5，若已有 sda1~sda9 则跳过（分区与整盘冲突，T75378/T53606）
        mount -o usefree -t vfat /dev/$MDEV /mnt/udisk
        成功才 prop_set sys.usb.device.state udisk:1，失败 exit 且不改属性
remove: umount /mnt/udisk；无论成败都 prop_set ... udisk:0
```

随后 `usb_detect` 线程监听属性 → `udisk_insert_state_changed()` → `dmUsb` 仅在状态变化时抛 `DM_EVENT_USB_STATUS`（去重，不是消抖）→ `EVT_UDISK_ADD/REMOVE`。因此：**USB 已枚举 ≠ UI 一定 ADD**（mount 失败就不会置 `udisk:1`）；**块设备 remove ≠ umount 一定成功**，但 UI 仍按 REMOVE 走。这一层没有插拔消抖。

### U 盘升级流程（A330 / Android）

- **扫描**：`findFromSdOrUsb` 扫描已连接外部存储（SD 卡、U 盘）根目录找固件包；**不支持 NTFS 与 exFAT**。`getValidFirmwareImageFile` 区分 OTA 包与整包固件。
- **路径转换**：应用给出的路径 `/storage/<卷ID>/xxx.zip`，`RKRecoverySystem.installPackage()` 会转成 `/mnt/media_rw/<卷ID>/xxx.zip`。
- **两种升级方式**：A/B（`update_engine` + `payload.bin`，签名在 payload 内部，块级差异更新）与传统 recovery（`system.img`/`vendor.img`，外部 `.zip` 签名）。本地 U 盘路径实际走 A/B，远程走 recovery。
- **block.map / uncrypt**：传统系统需要 block.map 让 recovery 访问 `/data` 上的包；A/B 包不需要。若 A/B 包放在 `/data` 又被触发 uncrypt，会生成无用的 block.map，recovery 侧自然失败。
- **模块集成**：`SystemUpdate` 源码放进 `vendor/apps/SystemUpdate/`，`mmm vendor/apps/SystemUpdate/` 出 `SystemUpdate.apk` 与 `librockchip_update_jni.so`；再以 prebuilt 形式（`vendor/prebuilt/apks/SystemUpdate/` + `Android.mk` + `lib/arm64-v8a/`）集成，并在 `vendor/configs/chips/rk3576/config.yaml` 的 `packages` 加 `SystemUpdate`、`remove_packages` 加 `RKUpdateService`，避免与原升级服务冲突。

### USB 虚拟串口（TTY）读写流程

Linux 下 USB 串口/dev 节点通常是 `/dev/ttyUSB*`（USB 转串口、Modem 类）或 `/dev/ttyACM*`（CDC-ACM，如 Arduino）。基础流程：

1. **识别**：`ls /dev/ttyUSB*`、`ls /dev/ttyACM*`；`lsusb` 看 VID/PID；`dmesg | grep -i usb` 看枚举与驱动绑定。
2. **配置（仅物理串口类需要）**：`tcgetattr/tcsetattr` 设波特率与 8N1、关软件流控、原始模式、`VMIN/VTIME` 超时。
3. **读写**：`read()`/`write()` 直接收发；Python 可用 `pyserial`。
4. **调试**：`stty -F /dev/ttyUSB0 -a` 看配置，`screen /dev/ttyUSB0 115200` 手动交互；注意权限（`dialout` 组/root）、避免多进程并发访问、按协议处理分帧。

**USB 虚拟串口的特殊性**：设备经 USB 接入时，波特率等参数只是被传递、通常被忽略，实际速率由 USB 总线决定。EM60 这类设备的正确用法就是 `open("/dev/ttyUSB0", O_RDWR | O_NOCTTY)` 后直接 `read/write`，不需要 `tcgetattr`/`cfsetispeed`：

```c
int fd = open("/dev/ttyUSB0", O_RDWR | O_NOCTTY);
/* 无需配置波特率/数据位/停止位 */
write(fd, data, len);
read(fd, buf, size);
close(fd);
```

另有两点与「多设备/拔插」直接相关：

- **内核按物理设备管理节点，不按下标**：插入第一台生成 `ttyUSB0`、级联第二台生成 `ttyUSB1`；拔出时内核发 `remove` 并带 `DEVNAME=ttyUSB0|ttyUSB1`，同一设备插拔的 `DEVNAME` 一致，因此可用它维护「节点 → 设备」映射，**不需要依赖拔插顺序**。
- **`option` 驱动的 `option_ids` 是白名单**：接口类为厂商自定义（`bInterfaceClass=ff`）且 VID/PID 不在表里时，驱动不绑定、不生成节点；此时可用 `new_id` 机制先做原理验证：

```
echo "1d6b 0104" > /sys/bus/usb-serial/drivers/option1/new_id
ls -l /dev/ttyUSB*        # 验证通过后再把 { USB_DEVICE(0x1d6b, 0x0104) } 加进 option_ids
```

### host 与 gadget 的边界

源文件覆盖的全部是 **Host 侧**路径：U 盘插入 → 枚举 → MSC → 挂载/卸载；USB 串口模块插入 → option 驱动 → tty 节点。`VBUS`/`SESSION` 在 Host 模式下保持供电是「不断开 5V 才能继续检测插入」的前提。**Device/gadget 侧（把整机当 U 盘/串口设备被 PC 识别）的切换流程、协议栈与状态机，在现有源文件中没有实现级材料**，此处不做推测（见文末）。

---

## 调试过程记录

### T134088：MB12 待机下多次插拔 U 盘异常

- **现象**：待机下多次插拔（含 HS chirp 偏慢的盘，如 325d）时，单次插入反复 mount/unmount；EP0 报 `-116`（ETIMEDOUT）；`Failed to enable port 1` 刷屏；CPU 冻机；盘还插着却再也认不到；`vQueueDelete` 断言。
- **定位手段**：串口日志 + 源码对照（以源码为准，联调日志仅作线索）；按「边沿 → apply → Reset → 枚举 → 应用 mount」逐层加打印，观察 `want/gen/pe/enum_ok` 与电气态。
- **根因**（逐条对应修复）：
  1. IRQ 每条边沿立即改 `pe/CSC` 并入队 → 抖动被当成多次真插拔；
  2. Reset 期 SE0 报假 DISCON 被当真 → `want/pe` 被清 → `Failed to enable`；
  3. Reset 后立刻读速度，慢 HS chirp 先报 FSDEV → 按全速配 EP0 → 整段 `-116`；
  4. 对空端口/已回弹端口仍按 `pe` 快照发 RESET → 纯噪声；
  5. 枚举失败路径对 PHY/时钟上下电 → 运行中关 USB 时钟/电源域后访问 MUSB 寄存器挂死；
  6. 失败 SW disconnect 清 want → 无新 CONN 边沿则永久认不到；
  7. 只看 `pe` 判「已连接」→ `Failed to enable` 留下 pe 残影，再插被 already-pe 吞掉；
  8. `f_mount` 失败未 unlock 就删同步对象 → `vQueueDelete` 断言；同步对象被他人持有时被强删；
  9. 应用层重复卸载/竞态；根口事件位不回写导致每轮 apply 重扫端口、`pe=0` 时白跑 400ms 消抖。
- **修改**：见 §3.3/§3.5；另含 Hub 层四处 root 特判（假 `C_CONNECTION` 忽略、RESET 前/后/枚举前判 `want`、enable 失败清残影 + 200ms 就地重试一次、`portchange==0` 不刷屏）、断开处理幂等（`!child->connected` 直接返回）、Hub 资源释放与初始化失败逐级上抛、应用层 `seq + mounted + unmounting` 临界区、GPIO 先 `gpio_dev_unmap()`、FLAG 由低电平改下降沿（开漏低有效，低电平会中断风暴）。
- **验证结论**：待机下连续多次插拔稳定 mount/unmount，无冻机，无长时间 `Failed to enable port 1` 假刷屏；枚举失败时可见 `soft recover (no phy refresh)` → `root recover last resort: controller soft reinit` → `root HOLD keep want ...` → `root HOLD retry connect` 的层级行为；真拔后不再出现「拔掉仍报 want=1」；快速插拔不再出现 `vQueueDelete` 断言。对应提交 `c0e55989`。

### CLI FatFs 卸载崩溃与写长度为 0

- **现象**：`ap_cmd fatfstest S 2` 列目录失败（`fr=18`）后，直接执行 `ap_cmd fatfstest U 2` 卸载会崩溃，日志 `MMFAR=0x18`、`MemFault`；另外按文档示例 `fatfstest W 2 abc.txt ABCDEFG` 写入 0 字节。
- **定位手段**：串口日志定位故障地址 → 对照 `test_fatfs.c`/`ff.c`/`disk_io.c` 调用链（`f_unmount` → `f_mount(NULL,path,opt)` → `find_volume` 失败分支 → `clear_lock(NULL)`）。
- **根因**：`test_unmount()` 调用 `f_unmount(number, cFileName, 1)`，`opt=1` 让 `f_mount` 在卸载后立刻重找卷，此时 `fs` 为 NULL，`clear_lock(fs)` 访问空指针偏移 `0x18`；`disk_uninitialize()` 的 `DEV_USB` 分支只 `break` 导致 `f_unmount` 恒为 `FR_DISK_ERR`；CLI 的 `W` 命令 5 参数时 `content_len` 未赋值。
- **修改**：

```c
/* test_fatfs.c */
-fr = f_unmount(number, cFileName, 1);
+fr = f_unmount(number, cFileName, 0);

/* ff.c：卸载后重找卷失败时，fs 可能为 NULL，勿对空指针 clear_lock */
#if FF_FS_LOCK != 0
-    clear_lock(fs);
+    if (fs) clear_lock(fs);
#endif
```

  同时 `f_unmount` 内部固定以 `f_mount(0, path, 0)` 注销卷；`disk_uninitialize()` 在 USB Host + MSC 配置下返回 `RES_OK`；`test_unmount` 成功后释放 `pfs`；`cli_fatfs.c` 的 `W` 命令补 `content_len = strlen(write_content)`。
- **验证结论**：卸载不再崩溃，`f_unmount` 返回 `FR_OK`；CLI 写文件内容长度正确。相关问题单 T122416 / T120959。

### V67 无法识别 EM60（无 ttyUSB 节点）

- **现象**：插入 EM60 前后「识别不到」，无 `/dev/ttyUSB*`；`cat /proc/tty/driver/usbserial` 无输出。
- **定位手段**（四阶段递进）：
  1. **物理层**：`dmesg | grep -i usb` 看到 `New USB device found, idVendor=1d6b, idProduct=0104`，识别为 `Extend Board` → 枚举成功、硬件链路正常；
  2. **节点与类**：`ls -l /dev/ttyUSB*` 报 `No such file or directory`；`cat /sys/bus/usb/devices/1-1.1/1-1.1:1.0/bInterfaceClass` 返回 `ff`（厂商自定义类），子类/协议均为 `00` → 内核默认驱动不匹配，未生成节点。`lsusb` 另见 `1a86:8091`（HUB 芯片）与 `1d6b:0104`（内核表示的 Extend Board）；
  3. **内核能力**：`zcat /proc/config.gz | grep CONFIG_USB_SERIAL` 得到 `CONFIG_USB_SERIAL_OPTION=y`，通用 option 驱动已静态集成，但内置 ID 表缺 `1d6b:0104`；
  4. **原理验证（PoC）**：`echo "1d6b 0104" > /sys/bus/usb-serial/drivers/option1/new_id`，`/dev/ttyUSB0` 立刻生成 → 硬件、链路、驱动本身都通，唯一障碍是「内核不认识这个 ID」。
- **修改**：在 `drivers/usb/serial/option.c` 的 `option_ids` 中增加 `{ USB_DEVICE(0x1d6b, 0x0104) }`。
- **验证结论**：节点稳定生成，可直接对 `/dev/ttyUSB0` 读写；两台 EM60 级联时插拔 `uevent` 的 `DEVNAME` 一一对应，分离不依赖接入顺序。
- **附带项**：V67 编译时更新分区表报错，属于烧录工具配置文件不对，重新导入 config 并每次烧录勾选 loader 与 vbmeta 即可。

### V67 拔插 EM60 触发网络重连

- **现象**：重启期间插着 EM60，起来后拔出，以太网 `eth0` 经历 `DISCONNECTED → 清 IP → DHCP 重建 → CONNECTED`，用户可见图标短暂异常；另一次表现为 `vdroidserver` 进程 PID 变化、收不到拔出广播。
- **定位手段**：
  1. `adb bugreport` 确认断网真实存在：拔出后约 5s，`ConnectivityService` 由 CONNECTED → DISCONNECTED，`Clearing all IP addresses on eth0`，随后重新注册网络；
  2. `dmesg` 抓到完整链条：`option1 ttyUSB0: ... now disconnected from ttyUSB0` → `init: Service 'vdroidserver' (pid 326) received signal 1` → `init: Sending signal 9 ...` → `starting service 'vdroidserver'`；
  3. 代码审阅：`open(dev, O_RDWR | O_NONBLOCK)` **缺少 `O_NOCTTY`**，设备成为进程控制终端，断开时内核发 SIGHUP，进程默认动作是退出；
  4. 对比测试排除权限：`adb shell` 跑 Demo 报 `Permission denied`（shell 无 radio 组权限），`adb root` 可打开，`getenforce` 为 `Permissive` → 权限不是根因；
  5. 同事两次修改对比：注释 `SetupPort` 保留 `open` → 拔插崩溃；整段注释 `open` 函数 → 不崩溃但 EM60 通信功能丧失（不是修复，是牺牲功能换稳定）。
- **根因**：`open()` 缺 `O_NOCTTY`（根本原因）；`vdroidserver` 未忽略 SIGHUP（次要）；串口初始化函数被注释（隐患）；SELinux 策略不完整、有大量 `avc: denied`（Enforcing 下会出问题）。
- **修改**：`open(dev, O_RDWR | O_NOCTTY)` 并恢复端口配置；建议在 `main()` 加 `signal(SIGHUP, SIG_IGN)`；长期补 `allow ... tty_device/serial_device:chr_file rw_file_perms` 等策略。
- **验证结论**：补齐 `O_NOCTTY` 后拔插不再触发进程重启与以太网重建；用 `pidof vdroidserver` 对比拔插前后 PID 可确认。

### T111233：A330 U 盘升级失败（Permission denied）

- **现象**：U 盘内升级包无法升级，日志 `RecoverySystemService: Failed to reserve space for compressed apex: java.io.FileNotFoundException: /mnt/media_rw/<卷ID>/vendor_update.zip (Permission denied)`。
- **定位手段**：`dumpsys package android.rockchip.update.service`、`ps -A | grep`、`cat /proc/<pid>/status | grep Groups` 查进程身份；`dumpsys | grep -A5 -B5 "RecoverySystem"`、`service list | grep recovery` 查服务归属；`cat /proc/$(pidof system_server)/attr/current` 确认 `system_server` 域；对比 `/storage/<卷ID>/` 与 `/mnt/media_rw/<卷ID>/` 两条路径的可访问性。
- **根因**：包路径由 `/storage/<卷ID>/` 被 `RKRecoverySystem.installPackage()` 转换成 `/mnt/media_rw/<卷ID>/`，`system_server` 域对 `mnt_media_rw_file`（目录缺 search）与 `vfat`（文件缺 getattr/read/open/map）无权限，属 **SELinux 策略**问题；且 `vfat` 被标记为 `sdcard_type`，而 `system_server` 被 neverallow 明确禁止访问该类型，不能简单给整个 vfat 类型加权限。
- **试过的路线**（含反例）：`setenforce 0`、把 apk 移到 `/system/priv-app/`、改用应用私有目录（recovery 无法访问正常运行的私有目录）、`cp` 到 `/data/ota_package/` 或 `/cache/recovery/` 再升级、单独编译并 push `system/vendor/system_ext/product/etc/selinux`、跳过时间戳检查与文件类型检查、跳过 A/B 包检查并用硬编码路径 —— 均未闭环，`update_engine_sideload` 仍返回 1。
- **附带结论**：该机型走 A/B 更新，若 OTA 包落在 `/data` 被触发 uncrypt 会生成 block.map，而 A/B 包不需要 block.map，进而「安装方式与包格式不匹配」；`package->GetType() == PackageType::kFile` 检查失败说明实际传参是块映射路径而非文件路径。
- **遗留**：源记录未见最终解决提交与验证结论（见文末）。

### A330 升级弹窗与进度展示问题

- **T121287（设备恢复出厂/升级后异常弹窗）**：
  - 现象：A/B 升级失败重启后仍弹失败窗；A/B 升级成功且用户关掉成功弹窗后，每次重启又弹「是否删包」。
  - 定位：失败分支已写 `updating$path=...` 到 `/cache/recovery/last_flag` 但未清除，重启后 `onCreate` 读到大字符串误判失败并拉起通知界面；成功分支写 `success$path=...` 后从未删除该文件，进程重建时 `mIsFirstStartUp` 又为 true。
  - 修改：`RKRecoverySystem.java` 新增清除标志文件的方法；`RKUpdateService.java` 在 A/B 非 SUCCESS 时清除，开机读到陈旧 `updating$...` 只打日志并清除；`NotifyDeleteActivity.java` 在成功提示 `onDestroy` 时清除。
  - 验证：重启不再重复弹窗，失败只在当前会话提示一次。
- **T121312（U 盘升级不显示进度条）**：旧流程由 `RKUpdateService` 以后台通知（Notification）展示进度，仅在准备完成后才弹「是否重启」确认框。改法是把 U 盘 A/B 的下载阶段改为「校验成功后拉起专用全屏进度界面」：新增全屏 Activity（监听进度广播、屏蔽返回键、拦截 Home/Recent/Menu/Back、`StatusBarManager.disable(...)` 禁止下拉通知栏、沉浸式全屏）、新增居中卡片布局、`FirmwareUpdatingActivity` 把当前版本/升级版本/是否使用强制进度界面传给服务、成功后不再弹确认框而是延迟约 1.2s 直接重启、失败分支收口避免停在中间进度页；仅对「可移动存储上的 A/B 升级」启用。
- **T121315（放弃 U 盘升级后反复弹窗）**：
  - 现象：插入含升级包的 U 盘弹出提示，点「放弃」或返回键关闭后，只要 U 盘未拔出就会再次弹出。
  - 根因：UI 层取消按钮只 `finish()` 未通知服务端拒绝；服务层未按 U 盘会话抑制，每次 `COMMAND_CHECK_LOCAL_UPDATING` 都重新扫描弹窗；广播（BOOT_COMPLETED / MEDIA_MOUNTED / USB_STATE）可多次触发检查命令，消息堆积后连续拉起多个弹窗实例。
  - 修改：从挂载路径提取会话 ID（`/storage/<卷ID>/` → `<卷ID>`），服务端维护「已处理会话」集合，弹窗前先判重、弹窗启动即标记，拔盘时延迟校验卷已移除再清除标记，入队前对同类检查消息去重，并修复界面中广播接收器与服务绑定的释放问题。
  - 验证：同次插入只弹一次，关闭后到拔盘前不再重复；拔出后状态清零，重插恢复；升级链路正常进入 A/B 流程。

### T112391：U 盘插拔相关的文件描述符泄漏（某任务）

- **现象**：进程 `aexn` 在 USB 拔插后 FD 数量稳步增长且不下降。
- **定位手段**：
  1. `watch -n 1 "ls -l /proc/$PID/fd | wc -l"`（或 `lsof -p $PID | wc -l`）量化，确认增长趋势；
  2. 查看 FD 类型，发现大量 `(deleted)` 描述符 —— 典型形态为 `/dev/input/eventX` 被打开后设备被拔出、节点消失但进程未关闭；
  3. `strace -p $PID -o <log> -f -e trace=file,desc` 抓取系统调用，再用 `grep -E "(open|openat|close|socket|dup|dup2)"` 过滤，定位到 PID 对应的 `openat(AT_FDCWD, "/dev/input/event7", O_RDONLY|O_NONBLOCK) = 68`、`event8 = 69` 之后 **没有对应的 close**。
- **根因**：USB 输入设备（键鼠/触摸等）热插拔时，进程打开的设备节点未做关闭处理，每次拔插泄漏一个 FD。
- **修改/验证**：源记录止于定位（末尾为编译错误摘记），未见修复提交与复测结论（见文末）。

---

## 结论、注意事项与遗留问题

### 结论

1. **检测归属固定**：CONN/DISCON 由 PHY + 控制器给出，软件只读边沿与状态位；机械 GPIO 只做提示，不参与 USB 判定。
2. **ISR 不能当终裁**：中断里只记「瞬时意图」（BK 的 `want` / Linux 的 `port_connect_status`），抖动会来回翻；真正的 USB 结论在 Hub 消抖之后。
3. **消抖要「连续稳定」而不是「等超时看最后一拍」**：BK 初版断开路径跑满 400ms 后按最后一拍决定，会放大毛刺；Linux 用「连续 100ms 状态不变、一抖清零、2s 超时判失败」更稳，且连/断都有明确出口。
4. **复位必须与消抖解耦**：消抖只做一次；复位期间 Linux 当轮读状态（`-ENOTCONN` 立即停、仍连但有变化位则 `-EAGAIN` 再复位），而 BK 修后才通过 `s_root_in_reset` + 三级 want 判定 + 电气态判定避免「对空端口复位」与「强制 pe=1 硬去枚举」。
5. **失败要能自愈，但不能靠硬掉电**：`want` 分级恢复（soft → 控制器软重配 → HOLD + tick 退避）+ 三出口清理 `want`，比 VBUS 脉冲/PHY 时钟上下电安全得多 —— 后者在 Host 运行中会让 CPU 访问 MUSB 寄存器直接挂死。
6. **文件系统与业务层各有一道「竞态关」**：FatFS 侧要保证「先解锁再删同步对象、删不掉则暂存、删前查持有者」；应用侧要用 `seq/mounted/unmounting` 或「已处理会话集合」防重复挂载/卸载与重复弹窗。
7. **串口（USB 虚拟串口）打开务必带 `O_NOCTTY`**，并在必要时忽略 SIGHUP，否则拔插会导致进程被杀、进而引发下游服务（如以太网）重建。

### 注意事项

- 调参影响面：`ROOT_QUIET_MS`(200ms) 调小更快落地但易误判；`ROOT_HS_SETTLE_MAX_MS`(100ms)、`ROOT_RESET_ATTEMPTS`(3) 是为慢 HS chirp 盘（如 325d）留的余量，压缩会退化为 FS 误判与 `-116`。
- 共用 USB/FatFS 的改动需串行全产品编译验证（`./tools/build_all_qemu_voip_products.sh`）。
- GPIO 使用前先 `gpio_dev_unmap()` 清第二功能复用；开漏低有效信号用下降沿而非低电平触发。
- U 盘升级路径受文件系统格式限制（不支持 NTFS/exFAT），整盘挂载与分区挂载冲突（T75378/T53606）需在脚本层规避。
- SELinux 侧：`vfat` 属于 `sdcard_type`，`system_server` 被 neverallow 限制，建议为特定文件新建类型后单独授权，而不是给整个类型放开。

### 遗留问题

- A330 U 盘升级的 SELinux 权限问题未见最终闭环方案与验证（多方案尝试后仍 `update_engine_sideload` 返回 1）。
- `aexn` 的 FD 泄漏只完成定位，未见修复与复测。
- 源材料中缺少 gadget/Device 侧（整机被 PC 识别为 U 盘/串口）的实现与切换流程，无法在本篇覆盖。
- 两侧消抖参数（BK 200ms/400ms 与 Linux 100ms）目前仍不一致；若需统一体验，建议在 Hub 之后或挂载/属性层增加合并窗口，而不是修改控制器中断语义。

---

## 附：信息不足的源文件

| 源文件 | 情况 |
|--------|------|
| `读写 USB TTY 设备（如串口设备、Arduino、GP…）.md` | 通用串口编程教程（识别/termios/读写/调试工具），**无项目信息、无现象与验证**，仅可作背景参考 |
| 一份内部任务排查记录（T112391） | 仅 60 余行排查方法记录，**只有定位过程、无根因结论与修复**，结尾为「编译错误」摘记 |
| `A330U盘升级.txt` | 碎片化笔记，含多条失败尝试与结论混杂（A/B 与 recovery 路径、block.map、SELinux），**缺少最终解决提交与验证结论**，部分结论互相矛盾（如是否走 uncrypt） |
| `BK  U盘验证.txt` | 有 `git diff` 与根因分析，但**缺少实测验证结论**（仅给出命令与预期输出） |
| `rk_usb_detect_flow.md` 与 `rk_usb_host_detect_and_debounce.md` | 同一主题的两版文稿，内容高度重复；本总结按较完整的一版归纳，重复部分未逐条对照 |
