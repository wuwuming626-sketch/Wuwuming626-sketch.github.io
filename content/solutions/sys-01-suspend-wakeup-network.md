+++
title = '系统与网络-01 休眠唤醒与网络异常'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 2
+++

A330i 版本 2.20.3 长时间静置后偶现黑屏（T118735），现场只留下黑屏状态下的一键导出包。顺着往下查，又撞上息屏进 deep 后唤醒要等 4～5 s、eth0 DMA 复位失败，以及重启后 eth0 与 wlan0 均 DOWN 无 IP。下面把这几条链路的排查过程完整记一遍。

## 概述（涉及问题清单）

本总结基于工作区内已有的串口日志、dmesg、logcat、bugreport、一键导出（dumptrace）等分析文档，只做两件事：**梳理相关技术流程**（电源/显示状态机与唤醒通路、按键与 input 事件链、开机网络初始化、输入法模块结构）与**复盘调试过程**（现象 → 定位手段 → 根因 → 修改 → 验证结论）。未做进一步实验，结论均来自源文件。

| 问题单 / 主题 | 现象 | 状态 |
|---------------|------|------|
| T118735（A330i，版本 2.20.3） | 长时间静置后偶现黑屏，音量/免提/拨号键有 tone、可回桌面，网页可登、可 ping 通，断电重启恢复 | 有现场 dumptrace；缺黑屏瞬间的 PowerManager/Display 框架日志，结论为推断 |
| T103168 | 通过应用持 PARTIAL_WAKE_LOCK「禁止进入深度休眠」，以规避唤醒后以太网断开 | 已定位「持锁有时序窗口」为仍会进休眠的原因 |
| 息屏→深度休眠→唤醒慢 | 唤醒后显示约 4～5 s 才恢复；eth0 DMA 复位失败 | 根因已定位到 rk_gmac/stmmac resume 路径与 VOP 恢复时序 |
| 重启后无网络 | eth0、wlan0 均为 DOWN 且无 IP；上层 netd/NetworkStack 正常 | 定位到 WiFi SELinux/VINTF/HAL 提前关闭 + eth0 未被 up |
| T108849 | 息屏下拿起手柄（挂钩）不能点亮屏幕 | 已实现由驱动注入 KEY_WAKEUP 唤醒事件 |
| 息屏下按免提键无反应 | 免提键键值 508 不属于唤醒键 | 已定位为键值未纳入唤醒判定 |
| 输入法（PinyinIME / 预置第三方输入法） | 候选字不显示、长按中英切换无反应、键盘闪烁、空格重复上屏、物理键盘下崩溃（T118448） | 均已修复并验证 |
| T100024 | 耳机按键支持（CONFIG_SUPPORT_HEADSET_KEY），与手柄/耳机检测同源 | 已在 adc-detect 驱动中实现 |

---

## 系统结构与关键路径

### 电源 / 显示 / 网络纵向路径

```
PowerManagerService（Going to sleep / Dozing / Going to sleep due to timeout）
        │
        ├─ DisplayPowerController → HAL → rockchip-vop2（vp1 enable/disable、dclk_vp1）→ 背光
        │
        └─ android.system.suspend-service（system_suspend）
                 │  写 /sys/power/wake_lock、/sys/power/wake_unlock
                 │  启停 automatic system suspend
                 ▼
             内核 PM：PM: suspend entry (deep) → PM: suspend exit
                 ├─ eth0: rk_gmac-dwmac / stmmac（DMA reset、MAC_VLAN_Tag_Filter、PHY link）
                 ├─ wlan0: SKWSDIO / SKWIFI（SKW_CMD_RESUME）
                 ├─ USB: xHC（USBSTS、root hub reinit）
                 └─ 音频: es8389（mclk_sai3/sai4 的 disable/unprepare）
```

判定「设备确实进过深度休眠」的日志关键字：`PM: suspend entry (deep)`、`Freezing user space processes`、`PM: suspend exit`；配合 `rockchip-vop2 ... Crtc atomic disable vp1`（息屏）与 `eth0: Link is Down` / `FPE workqueue stop`（网卡随休眠下电）。

### 按键与 input 事件链（两条并存通路）

- **标准 Android 通路（音量键等）**：物理按键 → 内核 input 子系统（扫描码 115）→ `InputReader` 识别为唤醒键 → `InputDispatcher` 分发 → `PhoneWindowManager` → `PowerManagerService.wakeUp()`，唤醒原因标记为 `WAKE_REASON_WAKE_KEY`。
- **厂商扩展通路（Aex 广播）**：AexServiceNative 监听 `/dev/input/eventX` → 产生 `INPUT_KEY_EVENT`（keyCode 24/25）→ AexService → 广播 `ACTION_INPUT_KEY_EVENT` → MediaSessionService → PowerManagerService 唤醒屏幕。
- **非按键类状态变化（手柄挂钩、耳机）**：走 extcon 子系统，见 3.4。

### 开机网络初始化路径

```
init（class main）
  └─ up_eth0：依赖 /system/bin/busybox；失败即 eth0 开机不被显式 up
rk_gmac-dwmac（RGMII）→ PHY 注册 → IPv6 NETDEV_CHANGE → eth0: Link is Up
  └─ EthernetNetworkFactory: eth0 onNetworkNeeded → DhcpClient: DHCPDISCOVER
WiFi：android.hardware.wifi-service → 读 SDIO uevent、insmod swt6652_wifi.ko / skw_sdio_v20.ko
      → wificond → 创建 wlan0 → wpa 相关 HAL（keystore）→ 连接 AP
```

注：源文件中未见 wpa_supplicant 自身日志，只在 wificond 注册 keystore HAL 失败时提到 WPA 能力受影响（见附录）。

### 输入法模块结构

- **PinyinIME（源码内建）**：Native 层（JNI/share：`pinyinime.cpp` JNI 接口、`matrixsearch.cpp` 动态规划切分与搜索、`dicttrie.cpp`/`dictlist.cpp` 词典、`spellingtrie.cpp` 音节树、`searchutility.cpp`）；Java 层（`PinyinIME.java` 逻辑、`SoftKeyboardView.java`、`SkbContainer.java` 键盘容器、`CandidatesContainer.java`/`CandidateView.java` 候选词视图、`ComposingView`、`CandidateViewListener.java`、`PinyinDecoderService`）。
- **预置第三方输入法（APK）**：以预编译 APK 形式放入 prebuilt apks 目录，经 `update_apk.py <apk> bundled_persist-app` 纳入镜像，再由 `config_default_input_method` / `config_enabled_input_method` 声明默认与启用列表。
- **系统配置入口**：`config.yaml`（chips 配置，控制打包模块）、`SettingsProvider` 的 `defaults.xml` 与 `DatabaseHelper.java`（默认值与首次开机初始化）。

---

## 技术流程

### 息屏 / 屏保 / 深度休眠状态机

以一次问题复现（息屏超时 15 s）为例，Android 侧状态与内核动作的对应关系：

```
16:11:27.108 PowerManagerService: Nap time
16:11:27.136 PowerGroup: Powering off display group due to timeout
             (millisSinceLastUserActivity=10031, lastUserActivityEvent=deviceState)
16:11:27.138 PowerManagerService: Going to sleep due to timeout
             (screenOffTimeout=15000, activityTimeoutWM=10000)
16:11:27.833 PowerManagerService: Dozing...          ← Android 浅睡（Doze）
16:11:27.835 DozeService 启动（DreamController）
16:11:28.341 PM: suspend entry (deep)                ← 内核深度休眠（由 system_suspend 线程触发）
```

关键理解：

1. **Dozing 只是 Android 层「浅睡」**，屏已关；是否真正进入内核 `PM: suspend entry (deep)`，由 system_suspend 与内核在「是否仍有 wakelock」上共同决定。
2. **持锁才能拦住 suspend**。禁止深度休眠的实现方式不是关掉休眠开关，而是**应用一直持有 PARTIAL_WAKE_LOCK**：VoIP SDK 前台服务与 Aex 各自加锁，再配合 vendor 配置。有锁时系统只关屏（Doze），不进 deep。
3. **持锁有「时间窗口」**：若息屏超时很短（15 s / 30 s），而持锁应用尚未启动，第一次超时就会落在「无锁窗口」内，系统照常进 deep。
4. **屏幕锁 ≠ 禁止休眠**：屏幕锁只影响解锁方式，不阻止息屏与 suspend。

正常与问题两次启动的差异（同为 screenOffTimeout=15000）：

| 项目 | 问题日志 | 正常日志 |
|------|----------|----------|
| Dozing 次数 | 2 次 | 1 次（另一次正常日志为 2 次） |
| `PM: suspend entry (deep)` | 出现（Dozing 后约 0.5 s） | 全程未出现 |
| suspend 前 suspend-service 日志 | 未抓到 `zygote_kwl` 相关行 | `error writing zygote_kwl to /sys/power/wake_unlock: Invalid argument` + `automatic system suspend enabled` |
| 唤醒方式 | `PM: suspend exit`（pending wakeup source: event0） | `Waking up from Dozing (WAKE_REASON_WAKE_KEY)` |
| eth0 | `Failed to reset the dma` | `Link is Up`，无 DMA 失败 |

结论：**「进 deep」的必要条件是息屏超时到点且此时没有 PARTIAL_WAKE_LOCK，充分性还取决于 Dozing 之后 system_suspend 与内核的交互**（wakelock 状态、suspend-service 行为、调度时序），因此存在「有时进、有时不进」的竞态，不能依赖偶然不进 deep。

### 唤醒通路与显示恢复时序（串口实证）

一次「息屏 → deep → RTC/输入唤醒」的完整内核时间线（单位：秒，内核时间戳）：

| 时间 | 事件 |
|------|------|
| 29.07 | `rockchip-vop2: Crtc atomic disable vp1`（关屏） |
| 29.64 | `PM: suspend entry (deep)` |
| 29.72 | SKWSDIO suspend indication |
| 29.80 / 29.92 | `es8389` 的 `mclk_sai3_to_io` / `mclk_sai4_to_io` **already disabled / already unprepared**（WARNING×2） |
| 29.82 | `eth0: Link is Down`、`FPE workqueue stop` |
| 29.97 | `PM: pm_system_irq_wakeup: 91 triggered hym8563`（RTC 唤醒） |
| 30.00～30.01 | 各 CPU 重新 up、`rk_gmac init for RGMII` |
| 33.06 | eth0 `configuring for phy/rgmii link mode` |
| 34.06 | `Failed to reset the dma` → `stmmac_hw_setup: DMA engine initialization failed` → `Timeout accessing MAC_VLAN_Tag_Filter`，随后 `Link is Up`（PHY 层恢复、MAC/DMA 已异常） |
| 34.07 | `xHC error in resume, USBSTS 0x401, Reinit`、`root hub lost power or was reset`；`goodix-ts` resume；`SKW_CMD_RESUME expect len: 149, recv len: 0` |
| 34.19 | `PM: suspend exit` |
| 34.23 | `rockchip-vop2: Update mode to 800x1280p52 ... set dclk_vp1 to 59400000`（显示恢复） |

即：**从唤醒到显示恢复约 4～5 s**，与「息屏后唤醒时间长、黑屏时间长」一致；同时 eth0 在该窗口内 DMA 初始化失败。

另一种唤醒路径（输入设备触发）：`PM: Pending Wakeup Sources: event0` → `Some devices failed to suspend, or early wake event detected` → `Abort: Pending Wakeup Sources: event0` → `PM: suspend exit`。说明设备**已经走完一遍 suspend 路径**（网卡等已下电）后被输入事件拉回，而非「从未休眠」。

### 按键与 input 事件链（含免提键 508）

息屏下按键唤醒的判定与分发流程：

```
按键按下 → 内核按键驱动扫描码（音量键 115）
   → InputReader：判断是否唤醒键
   → InputDispatcher → PhoneWindowManager
   → PowerManagerService.wakeUp() → 屏幕点亮
```

Aex 扩展路径（音量键）：

```
物理按键 → 内核 input 事件 → AexServiceNative 监听 /dev/input/eventX
   → INPUT_KEY_EVENT（scanCode 115 → keyCode 24）→ onKeyEvent(24, isPressed)
   → AexService.onEvent(keyCode:24) → 广播 ACTION_INPUT_KEY_EVENT
   → MediaSessionService → PowerManagerService 唤醒屏幕
```

实测问题：**免提键对应键值 508，未纳入唤醒键判定**，所以息屏下按免提键只产生普通按键事件、不触发 `wakeUp()`；音量键（`KEYCODE_VOLUME_UP`，`WAKE_REASON_WAKE_KEY`）可正常唤醒。

### 手柄挂钩（extcon）状态变化与「注入唤醒键」

手柄挂钩原本只上报状态变化、**不参与唤醒**：

```
手柄拿起 → 机械开关 → 内核 extcon（adc-detect-switch / extcon5）产生 uevent
  → UEventListener（netlink）→ EXTCON_EVENT → EventDispatcher → ExtconDevice::onEvent()
  → extconCallback → onKeyEvent(79, true) → AexServiceNative
  → 仅广播 HANDSET_HOOK_STATE_CHANGED（无 ACTION_INPUT_KEY_EVENT）
  → MediaSessionService / PowerManagerService 均未参与 ⇒ 不唤醒
```

驱动侧（`adc_detect_switch.c`）数据结构与唤醒实现要点：

```c
struct adc_detect {
    struct device *dev;
    struct extcon_dev *edev;
    struct input_dev *wakeup_input_dev;   /* 新增：专用的唤醒输入设备 */

    unsigned long handling_delay;
    struct delayed_work handler;

    int num_chans;
    struct iio_channel *chan;
    struct jack_device *handset, *headset, *linein, *lineout;
#if defined(CONFIG_SUPPORT_HEADSET_KEY)   /* T100024 */
    struct headset_key_data *map;         /* 耳机按键映射 */
    uint8_t key_nums;
    ...
#endif
};
```

挂钩状态变化时，向专用 input 设备注入 `KEY_WAKEUP`：

```c
if (state == 1 && g_detect_data->wakeup_input_dev) {
    input_report_key(g_detect_data->wakeup_input_dev, KEY_WAKEUP, 1);
    input_sync(g_detect_data->wakeup_input_dev);
    input_report_key(g_detect_data->wakeup_input_dev, KEY_WAKEUP, 0);
    input_sync(g_detect_data->wakeup_input_dev);
}
```

`wakeup_input_dev` 的注册/注销：`input_allocate_device()` → `name = "handset-wakeup"`、`phys = "adc-detect/wakeup"`、`id.bustype = BUS_HOST`、置位 `EV_KEY` 与 `KEY_WAKEUP` → `input_register_device()`；失败时 `input_free_device()`，卸载路径 `input_unregister_device()` + `input_free_device()`。对应提交为 T108849。

### 开机与网络初始化流程

**有线（eth0）**：init 的 `up_eth0` 服务 →（依赖 busybox）→ rk_gmac 注册、PHY（rtl8367rb）就绪、FPE workqueue、8021q VLAN → `eth0: Link is Up` → EthernetNetworkFactory 触发 `onNetworkNeeded` → DhcpClient 广播 `DHCPDISCOVER` → 取得 inet。

两处会破坏该流程：

1. `up_eth0` 因 busybox 缺失/标签错误起不来（每次启动都失败）；
2. resume 路径 `Failed to reset the dma`，即使 PHY 报 `Link is Up`，MAC/DMA 已异常，后续看门狗复位仍失败。

```text
[ 436.963] rk_gmac-dwmac eth0: NETDEV WATCHDOG: CPU: 0: transmit queue 0 timed out 10692 ms
[ 436.963] rk_gmac-dwmac eth0: Reset adapter.
[ 437.990] rk_gmac-dwmac: Failed to reset the dma
[ 437.990] rk_gmac-dwmac eth0: stmmac_hw_setup: DMA engine initialization failed
```

**无线（wlan0）**：wifi-service 启动 → 读 SDIO 设备 uevent、insmod `swt6652_wifi.ko` / `skw_sdio_v20.ko` → 驱动加载成功后 wificond 创建 wlan0 并配置 → 连接 AP（依赖 keystore HAL 注册）。问题场景中开机读 uevent 与 insmod 均被权限拒绝，驱动只能在后续重试中延迟加载。

### 输入法候选字显示与按键处理流程

候选字显示链路：

```
用户在软键盘点击拼音字母
  → SoftKeyboardView 捕获按键 → PinyinIME
  → JNI：nativeSearch(pinyinString, startPos)
  → matrixsearch 拼音切分/搜索 + dicttrie 词典查找
  → 回读候选：nativeGetCandidate(index) / nativeGetTotalCandidates()
  → PinyinIME.updateCandidates() → CandidatesContainer.showCandidates(list)
  → CandidateView（点击监听 CandidateViewListener）逐个加入容器
```

```java
// CandidatesContainer.java
public void showCandidates(List<Candidate> candidates) {
    removeAllViews();
    for (Candidate cand : candidates) {
        CandidateView cv = new CandidateView(getContext());
        cv.setCandidate(cand);
        cv.setOnClickListener(listener);
        addView(cv);
    }
}
```

候选条不可见时的判定方法：`View` 尺寸正确（1220x56）、`visibility=VISIBLE`，但 `isShown()` 为 `false` ⇒ **View 未真正挂到窗口层级**（父容器未挂载），而非布局问题；同时 `decoded_len=0`、`lpi_total_=0` 说明解码引擎未产出候选。

---

## 调试过程记录（按问题分组）

### T118735：A330i 静置后偶现黑屏

- **现象**：静置一段时间后仅屏幕黑，音量/免提/拨号键有 tone、可回桌面；网页可登、可 ping；断电重启恢复。
- **定位手段**：核对话机配置（屏保超时 7200 s）与多份日志的采集时机；重点使用**未重启、黑屏状态下**采集的一键导出包（设备 uptime 约 6 h 55 m，同一次开机），对比重启后抓取的 logcat。时间线（logcat-events）：

| 时间 | 事件 |
|------|------|
| 07:27 | BroadcastLauncher 启动（开机） |
| 07:32:46 | on_paused / on_stop |
| 09:31:36 | on_restart / on_resume |
| 09:49:31 → 14:17:15 | 约 4 h 28 m 无 `wm_` 界面活动（静置/息屏） |
| 14:17:15 | on_restart / on_resume（应用回前台） |
| 14:17:17～14:17:21 | 约 10 次 pause/resume（疑似黑屏下反复操作或多次尝试亮屏） |
| 14:17:21 | BroPhoneActivity 创建并 resume |
| 14:21:57 | `ACTION_KEY_EVENT keyCode 27`、`CLOSE_SYSTEM_DIALOGS`、`action.MAIN HOME`（按键回桌面） |

- **根因判断**：静置到屏保/息屏后设备进入或接近深度休眠；某次唤醒或显示状态机处理时**显示通道（VOP）/背光未正确恢复**，而 CPU、按键、音频、网络均已工作 → 「逻辑已唤醒、屏幕仍黑」。冷启会重新初始化显示与背光，故重启即恢复。
- **关键限制（为何只能推断）**：一键导出包内 `dumpsys power / display / SurfaceFlinger` 全部 Permission Denial（执行进程为应用进程，无 DUMP 权限），只能拿到 `debug.tracing.screen_brightness=0.3976283`；重启后的 logcat 不含黑屏瞬间的内核/框架日志。
- **副线索**：开机早期 `avc: denied { search } for comm="sh" name="leds" ... tcontext=u:object_r:sysfs_leds:s0 app=com.vdroid.broadcast`，即应用侧若通过 sysfs 访问 LED/背光会被 SELinux 拦截（正常背光应由 system_server 经 HAL 控制）。
- **验证结论/下一步**：黑屏出现后**不要重启**，立即 `adb logcat -d -b all`、`adb shell dmesg` 与串口日志（覆盖息屏前→黑屏→按键）；在 logcat 搜 `DisplayPowerController`、`PowerManager`、`requestPowerState`、`Going to sleep / Waking up`、`Backlight`，在 dmesg 搜 `vop`、`rockchip-vop`、`backlight`、`suspend`、`resume`，以区分「未发亮屏请求」与「驱动/背光未响应」。核对 2.20.3 是否已含 T103168 持锁修改，并比较**首次 suspend 时间**与**PARTIAL_WAKE_LOCK 首次 acquire 时间**。

### 息屏→深度休眠→唤醒慢（串口日志）

- **现象**：进屏保息屏后进入深度休眠，唤醒时间长。
- **定位手段**：按内核时间戳重建时间线（见 3.2），并把显示恢复点与 eth0 失败点对齐。
- **根因**：① 唤醒链路中 VOP2 到 `Update mode / set dclk_vp1` 约需 4～5 s；② `es8389` 在 suspend 路径对 `mclk_sai3/sai4` 重复 disable/unprepare（WARNING），可能拖慢/干扰 resume 顺序；③ `PowerManagerSer` 读 `vendor_default_prop` 被 avc denied，可能干扰屏保/休眠策略。
- **验证结论**：唤醒慢与黑屏是同一链路的两个表现；eth0 在同一 resume 窗口内 DMA 失败。

### 为何「已禁止休眠」后仍进入深度休眠

- **现象**：任务结论为设备无休眠场景，现场仅设屏幕锁、为便于复现缩短了休眠时间，静置一段时间后仍出问题；抓日志发现设备确实进了深度休眠。
- **定位手段**：从 logcat 直接读出触发原因，再与持锁应用的启动时间对齐：

| 时间 | 事件 |
|------|------|
| 16:11:11.798 | PowerManagerService 启动 |
| 16:11:14.212 | AexService（系统服务）启动 |
| 16:11:17.150 | `Unable to start service Intent { ... IAexAppService } ... not found`（Aex **应用**未起） |
| 16:11:27.138 | `Going to sleep due to timeout`（screenOffTimeout=15000） |
| 16:11:28.341 | `PM: suspend entry (deep)` |
| 16:11:59.998 | `Start proc: com.<vendor>.aex.privapp`（Aex 应用首次启动） |
| 16:12:00.049 | `Start proc: com.vdroid.broadcast` |
| 16:12:01.234 | `Start proc: com.vdroid.broadcast:VoIPService`（前台服务持锁） |

- **根因**：**持锁有「时间窗口」**。息屏超时仅 15 s，到点即触发 `Going to sleep due to timeout`；而持锁应用（Aex 应用与 BroadcastApp/VoIP 服务）比第一次超时晚约 32 s 才启动，suspend 发生时**没有任何 PARTIAL_WAKE_LOCK**，系统按策略进入 deep。屏幕锁不阻止 suspend；缩短休眠时间恰好放大了「落在无锁窗口」的概率。
- **验证结论/修改方向**：① 确认现场固件是否含 T103168 全部修改；② 复现时对比持锁 acquire 与 suspend entry 的先后；③ 从设计上缩小锁前窗口（在 Aex 等更早启动的组件甚至 system_server/固定系统服务持锁）；④ 对无休眠场景产品限制/隐藏过短休眠时间；⑤ 内核侧可用 `/sys/power/wake_lock`、`dumpsys power`、`dmesg | grep "suspend entry"` 验证持锁是否生效（例如看到 `PARTIAL_WAKE_LOCK 'PowerManagerService.PreventDeepSuspend'` 即表示在阻止深度休眠）。

### 重启后无网络（WiFi 权限 / VINTF / HAL 被提前关闭）

- **现象**：重启后无网络。定位日志为重启后 logcat。

| 时间 | 事件 |
|------|------|
| 16:52:30 | WiFi HAL 启动：读 `/sys/bus/sdio/devices/mmc1:0001:1/uevent`、insmod `swt6652_wifi.ko` / `skw_sdio_v20.ko` 均 **Permission denied**，驱动未就绪 |
| 16:52:31 | wificond 启动：`android.system.wifi.keystore@1.0::IKeystore/default must be in VINTF manifest` |
| 16:52:59 | 驱动**延迟加载成功**（`wifi_load_driver: Success`），Wifi HAL started；随即 `Unknown iface name: wlan0`、`check_wifi_chip_type_string : SKW6652: No such file or directory` |
| 16:52:59～16:53:00 | wlan0 被创建并配置（createClientInterface、Regulatory domain CN） |
| 16:53:00 | `tearDownClientInterface: wlan0` → `Stopping legacy HAL` → `Wifi HAL stopped`（WiFi 被主动关闭，距创建约 0.5 s） |
| 16:53:01 起 | `EthernetNetworkFactory: eth0: onNetworkNeeded`、`DhcpClient: Broadcasting DHCPDISCOVER`，未见 DHCPOFFER/ACK |
| 全程 | `ConnectivityService: NetReassign [a 0]`，无默认/活跃网络；应用层大量 `active network is not available` |

- **现场排查印证（重启后约 16 分钟同一设备）**：
  - 进程：netd、`com.android.networkstack.process`、`android.hardware.wifi-service`、wificond、surfaceflinger 均在运行 ⇒ **不是 netd/NetworkStack 崩溃**；
  - 接口：`eth0: state DOWN`、无 inet（仅 link/ether `xx:xx:xx:xx:xx:xx`）；`wlan0: state DOWN`、无 inet；
  - `ConnectivityService: unregister offer from providerId 1 : ... Specifier: <EthernetNetworkSpecifier (eth0)>` ⇒ 针对 eth0 的 offer 被撤销；
  - PC 侧 `ping 10.0.0.128` 返回「来自 10.0.0.180 的回复: 无法访问目标主机」⇒ 设备无有效默认网络。
- **根因归纳**：① WiFi 开机阶段 SELinux 拒绝（sysfs SDIO uevent 读、kernel module_load）；② 缺 VINTF 声明导致 wifi keystore HAL 无法注册（影响 WPA 能力）；③ 启动后很快 tearDown/stopLegacyHal，WiFi 未被保留；④ eth0 有 DHCP 尝试但接口未 up、无 IP（叠加 up_eth0 失败与可能的 DMA 问题）。
- **设备端排查命令（脱敏示例）**：

```bash
adb shell ip link show ; adb shell ip addr show eth0 ; adb shell ip addr show wlan0
adb shell getprop | grep -E "dhcp|wifi"
adb shell lshal | grep -i wifi
adb logcat -b events -d | grep -i avc ; adb shell dmesg | grep avc
```

- **验证结论**：「无网络」的两条物理路径都不可用，问题在接口/链路层与 DHCP/WiFi 连接建立，上层网络栈正常。

### up_eth0 与 eth0 状态（重启后无网络的第二层原因）

- **定位手段**：串口日志包含多次完整启停（多次 `init: Reboot start` / `reboot: Restarting system`，符合「反复重启才复现」），在其中检索 `up_eth0` 与 eth0 状态。
- **日志与根因**：

```
init: Could not start service 'up_eth0' as part of class 'main':
  File /system/bin/busybox(labeled "u:object_r:system_file:s0") has incorrect label
  or no domain transition from u:r:init:s0 to another SELinux domain defined.
```

另一份串口日志中表现为 `Cannot find '/system/bin/busybox': No such file or directory`。两种表现都导致 **up_eth0 每次启动都起不来**；若设计上依赖它把 eth0 置 up，则重启后 eth0 可能长期 DOWN。

- **「重启后无网络」的两层原因叠加**：先因深度休眠 + 驱动未适配导致某次运行 eth0 DMA 失败、无网络 → 用户重启 → 又因 up_eth0 失败导致新一次启动 eth0 未被 up → 仍无网络。
- **验证步骤（待执行）**：插网线 → 重启 → `adb shell ip link set eth0 up` → 观察 `ip addr show eth0` 与 DHCP 日志；纯重启场景抓串口/dmesg 确认是否有 `eth0: Link is Up` 且无 `stmmac_hw_setup` 失败。

### 修复优先级与分工（来自路线图）

| 优先级 | 事项 | 动作 |
|--------|------|------|
| P0 | eth0 开机 up | 补 busybox，或把 up_eth0 改为不依赖 busybox 的 one-shot（`ip link set eth0 up`）；若由 netd/EthernetNetworkFactory 负责则移除误导配置 |
| P0 | WiFi SELinux | 按 avc denied 为 wifi-service 放行 sysfs uevent 读与 kernel module_load |
| P0 | VINTF | 在设备 manifest 声明 `android.system.wifi.keystore@1.0::IKeystore/default` |
| P1 | WiFi 关闭逻辑 | 查 `tearDownClientInterface` / `stopLegacyHal` 调用点，延后或放宽「无客户端即关」 |
| P1 | eth0 resume | 修 rk_gmac/stmmac 在 resume 的 DMA、电源域、时钟顺序，必要时重试/延迟 |
| P2 | PowerManager / system_suspend | 放行 `vendor_default_prop` 读与 wakeup 相关 sysfs 读 |
| P2 | es8389 时钟 | suspend/resume 避免 `mclk_sai3/sai4` 重复 disable/unprepare |

回归场景：纯重启（插线/不插线）、进屏保→息屏→深度休眠→唤醒；若仍异常，补抓重启后 full logcat、dmesg/串口（开机到进桌面）、`dumpsys connectivity` 与 `ip addr`/`ip rule`。

### 息屏下按免提键无反应 / 手柄挂钩唤醒（T108849）

- **定位手段**：对比「音量键」与「手柄挂钩」两条链路的日志与代码路径，确认唤醒事件是否到达 PowerManagerService。免提键问题直接用键值比对：**免提键键值 508 不在唤醒键集合内** → 不触发 `wakeUp()`。
- **手柄挂钩根因**：挂钩状态变化只走 extcon，最终只广播 `HANDSET_HOOK_STATE_CHANGED`，**未发送 `ACTION_INPUT_KEY_EVENT`**，MediaSessionService 与 PowerManagerService 均未参与，因此「不唤醒」。
- **修改**：在 `adc-detect-switch` 驱动中新增专用唤醒 input 设备（`handset-wakeup`），挂钩状态变为拿起（state==1）时注入 `KEY_WAKEUP`（见 3.4 代码）；配合既有 `struct adc_detect` 中的 handset/headset 检测与 `CONFIG_SUPPORT_HEADSET_KEY`（T100024）耳机按键支持。
- **提交方式（脱敏）**：kernel 仓库在**内网 Git 服务器**上（Gerrit），配置 `~/.ssh/config` 的 Host 别名与私钥、安装 `commit-msg` 钩子后提交：`git add drivers/input/adc_detect_switch/adc_detect_switch.c` → `git commit -m "[T108849] [BUG] [A330] : Modify the handle hook event to serve as a wake-up event."` → `git push <remote> HEAD:refs/for/master`。
- **验证结论**：挂钩事件成为唤醒事件；可结合 `git reset --hard <SHA>` 回退到特定提交核对修改是否已带上（如排查某次休眠异常时对比 Aex native 绑定打印：正常情况下有 `AexService: Successfully bound to native service`，异常（进深度休眠）时该打印缺失，提示 AexService 初始化失败）。

### 输入法问题（预置第三方输入法 + PinyinIME）

**（1）预置第三方输入法（APK 方式）**

- **接入流程**：把 APK 放入 prebuilt apks 目录 → 执行 `python3 update_apk.py <apk> bundled_persist-app` → 在资源中声明默认/启用输入法。
- **配置项**：

```xml
<string name="config_default_input_method" translatable="false">com.android.inputmethod.latin/.LatinIME</string>
<string name="config_enabled_input_method" translatable="false">com.android.inputmethod.latin/.LatinIME:com.osfans.Trime.ime.core.TrimeInputMethodService</string>
```

- **现象与根因（启动即崩溃）**：

```
E AndroidRuntime: java.lang.RuntimeException: Unable to create service
  com.osfans.trime.ime.core.TrimeInputMethodService:
  java.io.FileNotFoundException: /storage/emulated/0/rime/build/trime.yaml: ENOENT
```

  `InputMethodService.onCreate` 直接读取外部配置目录，而**应用从未被手动启动过**时该文件不存在（只有 Application/Activity 的完整初始化流程才会从 APK 内复制依赖文件）。因此首次烧录后直接切到该输入法即崩溃。规避办法是先手动启动一次应用完成文件落地。
- **源码编译问题与解决**：拉取源码后子模块（librime-lua / librime-predict / librime-octagram）目录为空 → 手工复制到 `app/src/main/jni/librime/plugins/`；ABI 设置为 `arm64-v8a`、`x86_64`，`./gradlew clean` 后重新拉取（`git clone` + `git submodule update --init --recursive`）即可同步成功并编译通过；另有「同步/编译环境残留」问题，清理 IDE 安装目录与用户配置目录后重新拉取解决。
- **遗留**：仍缺部分配置，需后续跟进。

**（2）PinyinIME 候选字不显示**

- **定位手段**：`mmm vendor/<vendor>/apps/PinyinIME/` 编译后 push 验证（`pm list packages | grep pinyin`、`ime list -a`），并用 `adb logcat -s PinyinJNI` 过滤；在日志中对比 View 状态与解码器输出。
- **根因**：① 候选容器 `isShown()=false`（尺寸 1220x56 正常、visibility=VISIBLE，但未挂到窗口层级）；② `decoded_len=0`、`lpi_total_=0`，解码引擎未产出候选（找不到核心映射或字典文件）。
- **验证结论**：需同时保证候选容器挂载与 Native 层词典可加载。

**（3）长按中英文切换键无反应**

- **根因**：软键盘 `SkbContainer` 的 `LongPressTimer` 只对 `KEYCODE_DEL`、`repeatable()` 或 `getPopupResId() > 0` 的按键启动，而中/英切换键（`USERDEF_KEYCODE_LANG_2 = -2`）在 `skb_template1.xml` 中 `repeat="false"`，因此不会启动长按定时器、不会调用 `tryHandleLongPressSwitch()`；硬件侧 `aexn: Unmapped Key Code: 330` 表明该键未映射。
- **修改**：① `SkbContainer.java` 新增 `MSG_LANG_LONG_PRESS` 与 `handleLangKeyLongPress()`，对 code=-2/-4 的键启动 500 ms 长按定时器，触发后 `showOptionsMenu()` 弹出「输入法设置/切换输入法」，不再依赖 `mInputModeSwitcher`（避免空指针）；② `generic.kl` 增加 `key 330 LANG_SWITCH`，映射为 204，使长按可产生 `getRepeatCount() > 0`。

**（4）键盘闪烁**

- **根因**：每次按键都出现 `PopupWindow` 创建/销毁与 `Input channel object was disposed without first being removed`；`BalloonHint` 在按键尺寸变化时先 `dismiss()` 再 `show()`，导致频繁销毁重建。
- **修改**：`SoftKeyboardView.showBalloon()` 中改用 `delayedUpdate()` 更新位置尺寸，替代 `dismiss()` + `show()`。

**（5）拨号界面「你好」重复上屏与候选上下文缺失**

- **根因**：进入 `STATE_PREDICT` 后 `mComposingStr` 为已提交文本，`ComposingView` 仍显示中文（拼音区应只显示拼音）；预测列表首项与刚提交文本相同时，每次按空格都会再次选择提交，出现「你好你好你好…」。拨号界面在 `commitText("你好", 1)` 后 `InputConnection` 可能尚未更新，`getTextBeforeCursor` 返回 null/空，导致拿不到预测上下文（搜索框等更新较快的应用则正常）。
- **修改**：

```java
// updateComposingText()：预测模式隐藏 ComposingView
if (mImeState == ImeState.STATE_PREDICT) {
    visible = false;
}

// chooseAndUpdate()：预测仅一个候选且与刚提交相同，直接回空闲，避免空格重复选择
if (mDecInfo.mCandidatesList.size() == 1
        && resultStr.equals(mDecInfo.mCandidatesList.get(0))) {
    resetToIdleState(false);
    return;
}
```

  并在 `processStatePredict()` 中处理空格键：首候选与光标前文本相同时不重复选择，改为插入空格并重置；上下文取不到时用刚提交的 `resultStr` 作为预测上下文（可得到「啊/吗/像」等后续候选）。

**（6）T118448：接物理键盘时切换输入法崩溃**

- **现象**：设备接入键盘和鼠标，在设置搜索框输入、中英文输入法来回切换，反复弹出「屡次停止运行」。
- **根因**：物理键盘连接且未开启「使用屏幕键盘」时，候选容器 `mCandidatesContainer` 尚未初始化，但按键流程已调用 `chooseCandidate()` 取高亮候选索引，访问 null 导致 NPE。
- **修改**：`PinyinIME.java` 新增 `getActiveCandidatePosOrDefault()`（容器为 null 时返回默认索引 0），改写 `chooseCandidate()` 调用，并在所有使用 `mCandidatesContainer`、`mComposingView`、`mSkbContainer` 的路径加空判断；同时在 `SettingsProvider` 的 `defaults.xml` 新增 `def_show_ime_with_hard_keyboard = true`，使接物理键盘时默认显示软键盘，规避候选条未挂载的边界场景。
- **验证结论**：多次切换输入法不再出现崩溃弹窗，功能正常。修改文件为 `vendor/<vendor>/apps/PinyinIME/src/com/android/inputmethod/pinyin/PinyinIME.java` 与 `vendor/<vendor>/configs/chips/rk3576/overlays/frameworks/base/packages/SettingsProvider/res/values/defaults.xml`。

---

## 结论、注意事项与遗留问题

### 结论

1. **息屏/休眠**：禁止深度休眠依赖应用持 PARTIAL_WAKE_LOCK，而持锁存在「启动到持锁之间」的时间窗口；超时被改短（15 s/30 s）后，第一次 `Going to sleep due to timeout` 常落在无锁窗口内，系统即进入 `PM: suspend entry (deep)`。屏幕锁不阻止休眠。是否真正进 deep 还受 Dozing 之后 system_suspend/内核 wakelock 交互影响，存在竞态。
2. **唤醒通路**：唤醒后显示（VOP2 `Update mode` / `set dclk_vp1`）约 4～5 s 才恢复；`es8389` 时钟重复 disable/unprepare 的 WARNING 与 PowerManager 读 vendor 属性被拒可能进一步影响时序。
3. **网络**：同一平台存在两条独立故障路径——休眠唤醒后 `rk_gmac` DMA 复位失败（并有 NETDEV WATCHDOG 后再次失败，重启前即无网络）；重启后 WiFi 因 SELinux/VINTF/HAL 提前关闭不可用、eth0 因 `up_eth0` 失败未被 up，两接口均 DOWN 无 IP。
4. **按键/唤醒**：音量键走标准 input→PowerManagerService 通路可唤醒；免提键 508 未纳入唤醒键；手柄挂钩原本只发 extcon 状态广播，故新增驱动侧 `KEY_WAKEUP` 注入使其成为唤醒事件。
5. **黑屏（T118735）**：在缺少黑屏瞬间 PowerManager/Display 框架日志的前提下，结合一键导出时间线（应用已于 14:17 resume、14:21 有按键与回桌面）可推断为「系统与应用已唤醒、显示/背光未恢复」，与息屏/休眠/唤醒链路同源。

### 注意事项

- 判断是否进过休眠只认 `PM: suspend entry (deep)`；`Dozing` 只是 Android 层浅睡，两者不要混用。
- 「这次没进 deep」不代表问题消失，属于竞态偶然，修复必须保证息屏前已有持锁。
- dump / dumpsys 需具备 DUMP 权限；应用进程执行会被拒绝，现场取证应使用 root/系统权限或串口。
- SELinux 拒绝项（PowerManager 读 `vendor_default_prop`、system_suspend 读 `wakeup*`、system_server 读 extcon name、`/dev/vehicle` 写入、wifi-service 读 SDIO uevent 与模块加载）需按实际 avc 日志生成精确规则。

### 遗留问题

1. 缺少黑屏瞬间的 `dumpsys power/display` 与 system logcat/dmesg，T118735 仍未精确到具体请求或驱动调用失败点。
2. `rk_gmac/stmmac` resume 时 DMA 失败的**具体原因**（时序 / 电源时钟 / 状态不一致）待 BSP 进一步定位；冷启动路径是否也有 link 但未 up 待验证（`ip link set eth0 up` 实验未执行）。
3. WiFi HAL 被提前 tearDown/stopLegacyHal 的调用方与条件未确认；`Failed to create system directory skwifi`、`rk_vendor_read wifi mac address failed (-1)`、`SKW_CMD_RESUME expect len: 149, recv len: 0` 的内核侧修复未开始。
4. 预置第三方输入法仍缺部分配置（配置/主题文件落地问题），需后续跟进。
5. 上述 P0/P1/P2 修改的回归测试（纯重启、休眠唤醒两类场景）尚未执行。

---

## 附：信息不足的源文件

| 源文件 | 可用内容 | 不足 / 缺失 |
|--------|----------|-------------|
| T118735-A330i静置黑屏分析.md | 问题描述、配置（屏保 7200 s）、一键导出时间线、SELinux leds 拒绝 | 无黑屏瞬间的 PowerManager/Display 日志（导出包内 dumpsys 被权限拒绝），根因只能推断 |
| 串口日志分析-A330进屏保息屏后唤醒时间长.md | 完整内核时间线、eth0/WiFi/SELinux 线索 | 仅单次日志；无 CPU/时钟域寄存器的更细粒度信息 |
| 为何仍进入深度休眠-分析.md | 持锁机制与时间窗口分析 | 主要是结论性分析，缺少可直接核对的持锁 acquire 原始日志 |
| 重启后无网络-补充分析.md | 重启 logcat 时间线、现场 ps/ip 印证、排查命令 | 未见 DHCPOFFER/ACK；未包含串口（内核侧)对照 |
| 重启后无网络与深度休眠-日志分析报告.md | 深度休眠证据、正常/问题日志对比、Dozing 次数统计 | 「第二次 Dozing 未进 deep」只能推断（时序被打断 或 被 wakelock 拦住），无法唯一定论；引用到的《A330黑屏与重启异常分析报告》**未在本次源文件清单中提供**，其 §6.1/§6.2 细节无法核对 |
| 下一步分析与修复路线图.md | 结论汇总、待验证假设、P0～P2 优先级 | 三项快速验证（手动 up eth0、冷启 link 检查、WiFi 关闭逻辑）结果未回填 |
| A330设备息屏下按下按键无反应.txt | 按键/手柄两条事件链、免提键 508、驱动唤醒代码 | 免提键 508 的修改方案与验证结果缺失；提交步骤文本不完整 |
| 设备偶现放置一段时间黑屏.txt | 手动进入休眠的验证方法、`config_enableDeepSleep` 配置改动 | 未给出该 overlay 配置的最终生效验证结论；Aex native 绑定打印仅作为启发式判据 |
| A330添加输入法.txt | 预置 APK 流程、配置项、启动崩溃日志 | 编译环境问题记录零散；「缺少配置文件」一项未闭环 |
| A330输入法.txt | PinyinIME 模块结构、候选字流程与四处问题修复、T118448 | 部分小节为片段式记录；长按/闪烁改动的复测数据与提交 SHA 未记录 |
