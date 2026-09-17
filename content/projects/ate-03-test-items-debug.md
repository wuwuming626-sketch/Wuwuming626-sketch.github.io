+++
title = 'ATE-03 测试项实现与调试'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 3
tags = ['嵌入式', 'ATE 产测', '音频', '调试排障', 'BK7258 平台']
series = 'ATE 产测实战'
+++

语音回环的脾气我算是领教了：先是死活不出声；等它肯出声了，又开始啸叫。同一时期，MB12 的手柄回环通道一声不吭，单机菜单点进详情页也没反应——三件事看着互不相干，我却总觉得背后是同一只手在捣鬼。这段记录起于 2026-06-11，止于 2026-07-10。

> 本文整理自本司 ATE 相关工作记录（2026-06-11 至 2026-07-10），覆盖 BK7258 平台上各测试项的实现流程与开发过程中的调试记录。
> 文中已按脱敏要求处理厂商名、人名、邮箱与内网地址；文档与注释仅供参考，与源码冲突时以源码为准。

## 概述

本阶段的 ATE 工作集中在 BK7258（`sdk-repo` 仓库）上，涉及产品形态包括 i12、MB12 / MB12-V2、H2E、V50E、V60E，分支主要为 `0901_1748`、`0611`。工作内容可归为四类：

1. **音频类测试项落地**：语音回环（Voice Echo / Loopback）与 Tone 音，三机型共用同一套底层音频引擎，差异集中在路由与音量上限。
2. **产品差异化补测项**：MB12 的手柄回环通道（片外 codec I2S 环）、IR-CUT 滤光片、LED 告警灯与 PWM 灯、Active URI 键。
3. **单机 ATE 交互闭环**：预选界面 → 单机菜单 → 确认进详情 / 退回预选，以及退出与确认键的补齐。
4. **平台解耦与清理**：USB 存储测试的跨平台移植参考（不依赖 legacy-app 预编译库），以及开发期调试旁路代码的删除。

整体架构分三层：

```text
上层入口（单机/联机统一分流）
  ├─ 联机：bk_ate_vendor_msg.c（TR 协议解析）
  ├─ 有屏单机：bk_ate_standalone_ui.c（LVGL 菜单）
  └─ 无屏单机：bk_ate_standalone_headless.c（按键 + 静音灯反馈）
中间协调层
  ├─ 语音回环：bk_ate_ip_call.c（延时 → 起播 → 路由 → 按键）
  └─ Tone 音：bk_ate_tone.c（起播 → 路由 → 按键）
底层引擎
  ├─ 语音回环：bk_ate_voice_echo.c（mic → spk PCM 回环）
  └─ Tone 音：bk_ate_tone.c（定点正弦波 / 粉噪 → spk）
```

主要源码位置（相对 `sdk-repo/`）：

| 文件 | 职责 |
|------|------|
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_voice_echo.c` | 语音回环底层引擎 |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_tone.c` | Tone 音底层引擎 + 会话 |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_ip_call.c` | 语音回环协调层、路由与压簧事件 |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_vendor_msg.c` | 联机 TR 命令分发、RT 上报 |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_frame.c` | TCP 帧封装（`FF EE` + 长度 + body） |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_led.c` | LED / PWM 目标解析与驱动、加热联动 |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_preselect_ui.c` | 预选界面、静音长按轮询、opt43 联机入口 |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_standalone_ui.c` | 有屏单机菜单（含键映射） |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_active_uri_http.c` | Active URI HTTP 键（IR-CUT 等） |

## 测试项总览与调度路径

### 测试项与触发方式

| 测试项 | 联机命令 / 触发 | 单机入口 | 判定方 |
|--------|-----------------|----------|--------|
| 版本检查 | 版本命令 | 菜单项 | 自动（软件预设版本号一致即 PASS） |
| 按键测试 | 按键类命令 | 菜单项 / 数字键 | 全部按键测完自动通过 |
| LED（含告警灯） | `test_led` | 菜单项 / 数字键 | 自动交替闪烁，人工观察 |
| 插簧（弹簧） | hook 事件 | 菜单项 | 手柄放置两次有效后自动通过 |
| 语音回环 | `test_ip_call`（备 `test_voice_echo`） | 菜单项 / 数字键 | 人工听音后按通过/失败键 |
| Tone 音 | `test_tone` | 菜单项 / 数字键 | 人工听音后按通过/失败键 |
| IR-CUT | Active URI `IRCUTON` / `IRCUTOFF` | — | 观察滤光片切换 |
| USB 存储 | `test_usb_dev` | 本地菜单（仅写测） | 远程 ATE：写 + 读闭环 |
| 视频预览 | `test_video_preview` | — | 当前为占位回 success |
| 老化 Aging | 老化命令 | 菜单项 / 数字键 | 连续声压，人工 |
| 恢复出厂 / 重启 | 对应命令 | 菜单项 / 数字键 | one-shot 自动通过 |

### 联机协议与调度路径

联机走 TCP（端口 6668），帧格式为「帧头 `FF EE` + big-endian 长度 + ASCII body」，且**整帧必须单次 `lwip_send`**，分两次发送会被工装误判为半包。典型报文形如 `msg=TR&cmd=test_tone&action=start`。

```text
工装 PC ──TCP──→ 设备
  ├─ CR&cmd=connect&model=...  → bk_ate_session.c 建立会话
  ├─ TR&cmd=test_ip_call&action=start
  │    → bk_ate_vendor_msg.c 匹配 s_tr_profiles → BK_ATE_TRP_CUSTOM → tr_handle_custom()
  │    → bk_ate_ip_call_test_session_begin() → 2s 定时器 → 起播线程 → mic→spk 回环
  │    → 操作员按键 → RT result=success&reason=ate_ip_call_pass / failed
  └─ TR&cmd=test_ip_call&action=finished
       → bk_ate_app_voice_echo_stop() → 会话结束（未按键则补发 RT）
```

命令表 `s_tr_profiles` 中与本阶段相关项：

| cmd | 类型 | 说明 |
|-----|------|------|
| `test_voice_echo` | CUSTOM | 备用命令，与 `test_ip_call` 同处理 |
| `test_ip_call` | CUSTOM | 语音回环主命令 |
| `test_tone` | CUSTOM | Tone 音测试 |
| `test_video_preview` | CUSTOM（本阶段由 DEFAULT 改） | 占位，start 直接回 success |
| `test_usb_dev` | — | USB 测试结果标识（`success` 0/1） |

### 单机调度路径

**有屏（V50E / V60E / MB12，`CONFIG_BK_ATE_STANDALONE_UI=y`）**

```text
上电 → 音量+ / 音量- 组合键 ≥2s → 预选界面
  → 长按静音（默认 2000ms）→ 单机主菜单
  → 选择测项 → 详情页 → 自动起播（回环 2s 延时，Tone 立即）
  → # / * 判定通过 / 失败；免提键切路由；音量 +/- 调节
  → Soft1 返回主菜单 → 主菜单 Soft1 返回预选
```

**无屏（H2E，`CONFIG_BK_ATE_STANDALONE_HEADLESS=y`）**

```text
上电 → 组合键 ≥2s → 预选（静音灯常亮）→ 长按静音 ≥2s → 单机菜单
  → 数字键选测项：1 按键 / 2 LED / 3 语音回环 / 4 Tone / 5 弹簧
                  6 恢复出厂 / 7 重启 / 8 老化
  → 回环或 Tone：约 2s（Tone 立即）起播，默认免提，音量 +/- 调节
  → 短按 # → 静音灯闪 3 次 → 退回菜单；长按 # → 退回预选
```

H2E 与有屏单机的关键差异：默认路由（H2E 免提 / 有屏手柄）、判定方式（H2E 只有 `#` 退出、无 pass/fail 键）、反馈方式（静音灯闪烁 vs LVGL 屏显）。两套形态通过 Kconfig 互斥编译（`HEADLESS depends on !STANDALONE_UI`）。

## 各测试项技术流程

### 语音回环（Voice Echo）

**原理**：板载麦克风采集 PCM 直接写入板载喇叭，形成实时声学回环。音频参数 16 kHz / 16 bit / 单声道，帧长 640 字节（20ms），ring pool 8 帧。

**底层线程 `voice_loop_thread` 要点**

- 使用 `buf[2][1024]` ping-pong 双缓冲；
- **累加式读取**：`audio_record_read_data` 返回多少就累加多少，填满一帧才写播放，避免丢弃不足一帧的数据导致无声；
- mic 读失败退避 2ms 让 mic task 追上，连续失败超过 50 次退出线程；
- 播放写是非阻塞的，失败按 2ms 间隔重试，约 1000 次（~2s）后丢弃该帧；
- 前 6 帧与每 100 帧打印 `mic_peak`，便于诊断无声问题。

**设备生命周期**

```text
audio_record_create(ONBOARD_MIC) → audio_play_create(ONBOARD_SPEAKER)
  → record_open / play_open → audio_play_set_volume()
  → bk_aud_dac_unmute()（V60E）→ 创建 voice_loop_thread（优先级 6，栈 4096）
  → s_run=0 → 信号量等待线程退出 → play_destroy → record_destroy
```

**协调层 `bk_ate_ip_call.c`**

`bk_ate_ip_call_test_session_begin()`：保存 cmd → 设默认音量 45 → 设默认免提路由 → `route_apply()` → 启动**单次 2s 定时器** `CONFIG_BK_ATE_IP_CALL_DELAY_MS`。

定时器回调**不在 Tmr Svc 任务上下文**里直接调起播（会触发 DMA 分配，可能导致堆损坏），而是创建临时线程 `atevocdly`（优先级 6，栈 4096），在线程内调 `voice_echo_start()`，起播后立即重新应用路由。

**路由与压簧**

| 机型路径 | 实现 |
|----------|------|
| H2E（未启用 XGPIO） | 直接控制 `SPK_AMP_GPIO` + `HS_AMP_GPIO`：免提 → SPK=1 / HS=0；手柄 → SPK=0 / HS=1 |
| V50E / V60E（`CONFIG_BK_ATE_IP_CALL_ROUTE_XGPIO=y`） | 走 `bk_ate_route_gpio` 框架：GPIO21 为 DAC 输出总开关（LOW 连通），GPIO48 手柄功放，GPIO49 免提功放 |

hook 事件语义统一：`hook_off`（挂机/压簧）→ 手柄路由；`hook_on`（摘机/抬簧）→ 免提路由。hook 检测不可用时仅打 WARN 并降级继续放音。

### Tone 音测试

**原理**：纯软件生成正弦波/粉噪 PCM 写喇叭，不经过 mic。

| 参数 | 值 |
|------|-----|
| 采样率 / 位深 / 声道 | 16 kHz / 16 bit / 单声道 |
| 频率 | 600 Hz 正弦（偏低频，听感柔和而仍便于产线辨听） |
| 帧长 | 640 字节（320 sample × 2） |
| 幅度 | 正弦 0.18 × 32767；粉噪 0.15 × 32767 |
| Ring Buffer | 48 帧（30,720 字节） |
| 预填充 | 12 帧 |

**正弦生成**采用定点递推（复数旋转），不依赖 `libm`：角频率 `3π/40`，系数 `TONE_CR = 0.9723699204`、`TONE_SR = 0.2334453639`，每次迭代 `nr = r*CR - im*SR; ni = r*SR + im*CR`，输出 `im * TONE_AMP` 并 clamp 到 int16。**粉噪**用 Voss-McCartney 算法（7 阶状态 + xorshift32 白噪声），供老化场景使用。

**双线程生产者-消费者**架构：生产者生成一帧写 Ring Buffer，消费者等待预填充 12 帧后按 20ms 间隔取出并 `audio_play_write_data` 到 DAC；两线程优先级同为 8、栈 3072，每 2s 打印一次 RB 填充量作心率日志。

**写失败重试**：间隔 2ms，正弦模式最多 2000 次（~4s）后放弃并打错误日志；粉噪模式无上限（不能丢帧，老化要求连续声压）。

**音量与判定**：H2E 上限 50、V50E/V60E 上限 48，默认 45，步进 2；起播**无延时**（立即）。单机下无 pass/fail 键的机型以退出键结束，联机则由 `#` / `*` 触发 RT 上报。

### 按键测试

按键链路为事件驱动，ATE 模块以监听器形式接入，不改动正常按键逻辑：

```text
按键驱动 input_keypad.c → on_press_down/up → post_event() → keypad_task 线程
  → dmKeyNotifyProcess(keyCode, keyStatus) → dmKeyProcess() → uEventRaise(DM_EVENT_NAME_KEY)
  → ATE 模块监听器（测试已启动时）→ KeypadTestKeyProcess()
  → keypadTestEventSend() → 上报 PC 端 ATE 工具
```

按键类型识别基于时间阈值：短按 30ms、长按 800ms（`KEY_LONG`）、保持 1100ms（`KEY_HOLD`）、长按释放（`KEY_LONG_UP`）。另一条参考实现中，按键值通过 `BUS_MSG_T`（`type = BMSG_MEDIA_TYPE`，`arg = 按键值`）推送到 WiFi 核心的 `io_queue` 完成上报。

调试开关：打开 `CONFIG_DEBUG_VERSION` 才能看到应用层打印，可用 `ap_cmd xui_main` 拉起应用层。

### 插簧（弹簧）测试

进入测项后启动 hook 轮询（`bk_ate_hook_test_start`），依赖 `HOOK_DET_GPIO` 电平判定压簧/抬簧状态；将原机手柄放置于面板手柄位置两次、判定有效后自动通过。轮询同时服务于回环/Tone 的路由自动切换（见 3.1）。

### LED 测试（含告警灯与 PWM）

MB12-V2 的告警/状态灯并非全是普通 GPIO，部分走 PWM；`CONFIG_BK_ATE_HEAT` 打开时 LED 测项需与加热脚**同进同出**。该测项跨两仓协作：

```text
gui-repo tools/gpio_conf/mb12-v2/gpio.conf  →  打包到 /etc/gpio.conf
smp bk_ate_led.c
  load_targets_from_led_conf()   → GPIO / dual / HC595
  load_targets_from_gpio_conf()  → OUTPUT_GPIO* | OUTPUT_PWM*
  → ate_apply_all / 闪烁
      ├─ is_pwm  → ate_pwm_apply（start/stop）
      ├─ is_dreg → HC595
      └─ else    → GPIO / dual
  (+ CONFIG_BK_ATE_HEAT → led_heat_on/off)
```

灯脚名单以新增 4 行 conf 的形式登记，格式为 `NAME:dir,pin` 或 PWM `NAME:gpio,chan,duty%`：

```text
OUTPUT_GPIO3:0,55
OUTPUT_GPIO4:0,19
OUTPUT_GPIO5:0,26
OUTPUT_PWM1:18,0,100
```

PWM 首次点亮流程为 unmap → `bk_pwm_init(period=1000)` → start；熄灭只 `bk_pwm_stop`（不每次 deinit）；teardown 时 stop + deinit 并把脚拉低；未开 `CONFIG_PWM` 时解析到 PWM 行只警告并跳过。GPIO26（对应 LED5_R）需在 AP 与 Post 的 `usr_gpio_cfg.h` 中由 `GPIO_IO_DISABLE` 改为 `GPIO_OUTPUT_ENABLE`。加热联动以 `led_heat_on()` / `led_heat_off()` 挂在联机 `test_led start` 与单机常亮点亮/teardown 上。

### IR-CUT 测试

MB12 的红外截止滤光片由 AW9523 扩展口驱动**双稳态线圈**，只能发短脉冲，不能长时间通电。测试链路挂在联机 Active URI HTTP 键上：

```text
HTTP POST key=... → key_token_to_ircut_state
  → aw9523_ircut_pulse(state, 100ms)
  → Result=success|fail
```

| key token | 映射 | 含义 |
|-----------|------|------|
| `IRCUTON` / `F_IRCUTON` | `AW9523_IRCUT_A_TO_B` | 白天：滤光片切入 |
| `IRCUTOFF` / `F_IRCUTOFF` | `AW9523_IRCUT_B_TO_A` | 夜晚：滤光片切出 |

方向与实机相反时只需对调 HTTP 文件顶部的两个 STATE 宏。同一提交把 `test_video_preview` 在配置表中从 `DEFAULT` 改为 `CUSTOM`，`start` 直接回 success、`finish` 吞掉——只是让产测流程不阻塞，**不等于实现了视频预览能力**。

### USB 存储测试（跨平台移植参考）

该测试项在原方案中实现于 legacy-app 侧（`legacy-repo/legacy-app/ate/src/ateTestUsb.c`），通过回调注册（`ateUsbWriteCbRegister` / `ateUsbReadCbRegister`）由平台预编译库 `libplatform_ate.so` 调用。对 ATE 与 legacy-app 解耦的平台（如 BK），建议在 ATE 模块内自行实现等价的写/读函数，不链接 legacy-app：

```c
/* 返回值约定：0 = OK/成功，非 0 = ERROR/失败 */
int ate_usb_write_test(void);   /* 写 U 盘测试文件 */
int ate_usb_read_test(void);    /* 读 U 盘测试文件并比对内容 */
```

**关键判定结论**：远程 ATE 不是只看写成功，而是强制「先写后读」，两者都返回 0 才判 PASS，结果以 `testType = "test_usb_dev"`、`success = 1/0` 上报（`reason` 原实现为空串）。

```c
/* 等价还原自平台库 usbTestStart() */
void usbTestStart(void)
{
    if (_ateUsbWrite() != OK) {          /* 写失败 → FAIL，不再读 */
        ateGeneralResultEventSend("test_usb_dev", FALSE, "");
        return;
    }
    if (_ateUsbRead() == OK) {           /* 写成功后再读 */
        ateGeneralResultEventSend("test_usb_dev", TRUE, "");
    } else {
        ateGeneralResultEventSend("test_usb_dev", FALSE, "");
    }
}
```

**单步流程**（Write / Read 内部一致：检测盘 → mount → 操作 `usb.txt` → umount）

| 步骤 | 通过条件 | 失败情形 |
|------|----------|----------|
| 插盘检测 | `/dev/sda` 或 `/dev/sdb` 存在 | 超时仍无块设备 |
| 挂载 | `mount` 返回 0，挂载点可访问 | mount 失败 / 无可用分区 |
| 写测试 | 创建 `/mnt/udisk/usb.txt`，写入字节数 = `sizeof(测试串)`（含 `'\0'`） | 打开失败或长度不对 |
| 读测试 | 读出内容与测试串 `strcmp` 完全一致 | 无文件或内容不一致 |
| 卸载 | `umount /mnt/udisk` | 原实现卸载失败时写路径仍可能返回成功 |

测试常量：挂载点 `/mnt/udisk`，测试文件 `/mnt/udisk/usb.txt`，测试字符串 `"usb test...1234567890!~-=()*&^%$#@!"`，设备节点候选 `/dev/sda`、`/dev/sdb`。

**与「本地菜单 USB 测试」的差异**：本地 UI 只看写回调返回值，**只写不读**，属人工快捷自检；产线远程 ATE 必须按写 + 读闭环对齐。

### 单机 ATE 的进入、确认与退出

- **进详情**：`Soft4` / `OK` 之外增加 `DSS4`（keymap `NAV_RIGHT`），在 `resolve_keymap_codes` 中按产品门控赋值，日志 Keymap 行增加 `dss4=` 便于核对；
- **退回预选**：菜单态按 `*` 调 `bk_ate_standalone_request_preselect()`；`bk_ate_preselect_ui.c` 的退出日志由 `Soft1 ->` 改为 `key ->`，因为退出入口已不限 Soft1；
- **预选界面**：长按静音（`CONFIG_BK_ATE_STANDALONE_BOOT_MUTE_MS`，默认 2000ms）进单机菜单；解析到 DHCP opt43 的 `Vendor_ATE=` 则进联机 ATE UI。

### 硬件与编译配置速查

| Kconfig | 默认值 | 说明 |
|---------|--------|------|
| `CONFIG_BK_ATE_VOICE_ECHO` / `CONFIG_BK_ATE_TONE` | y | 编译对应测试项 |
| `CONFIG_BK_ATE_IP_CALL_DELAY_MS` | 2000 | 回环起播延时 |
| `CONFIG_BK_ATE_IP_CALL_VOL_MAX` / `CONFIG_BK_ATE_TONE_VOL_MAX` | 48 / H2E 50 | 音量上限 |
| `CONFIG_BK_ATE_TONE_VOL_STEP` / `CONFIG_BK_ATE_IP_CALL_VOL_STEP` | 2 | 音量步进 |
| `CONFIG_BK_ATE_IP_CALL_ROUTE_XGPIO` | 机型决定 | V50E/V60E 启用，H2E 不启用 |
| `CONFIG_BK_ATE_STANDALONE_UI` / `_HEADLESS` | 机型决定 | 有屏 / 无屏单机互斥开关 |
| `CONFIG_BK_ATE_MB12_LOOP_PATH2_HANDSET` | mb12-v2 AP = y | 手柄走片外 codec I2S 环 |
| `CONFIG_BK_ATE_HEAT` | 产品决定 | LED 测项与加热脚联动 |
| `CONFIG_BK_ATE_EHS` | V50E/V60E=y，H2E=n | EHS 耳机测试 |

编译命令示例（V60E / H2E）：

```text
make clean && ./projects/voip-project/scripts/voip_sdkconfig_target.sh board && \
  make bk7258 PROJECT=voip-project PRODUCT=H2E
make clean && make bk7258 PROJECT=voip-project PRODUCT=V60E
```

## 调试过程记录

### 语音回环「无声」

- **现象**：进入回环测项后喇叭无声。
- **定位**：`voice_loop_thread` 原先只在 `audio_record_read_data` 正好读满一帧时才写入播放，录制侧返回的不足一帧数据被直接丢弃，长期累积表现为无声。
- **修改**：改为 ping-pong 双缓冲 + 累加式读取，读满一帧即写播放；同时加入 mic 读失败 2ms 退避、连续失败超过 50 次退出线程的保护。
- **验证**：日志 `vloop #n mic_peak=... spk_write=640 tries=0` 能稳定输出，回环声连续。

### 回环啸叫与底噪

- **现象**：回环起播后易啸叫；板载回环存在电流音/底噪。
- **定位**：mic 与 spk 声学耦合形成正反馈；V60E 硬件耦合强于 H2E。
- **修改**：① 起播延时 2000ms（给音频 pipeline 建立时间，并留出操作员调整设备位置的时间），且延时回调内改为新建线程执行起播，避免在定时器服务任务里做 DMA 分配导致堆损坏；② V60E 在 `CONFIG_BK_ATE_IP_CALL_ROUTE_XGPIO` 下对 PCM 右移 1 位（约 −6dB）衰减，H2E 因耦合弱不做该项；③ 写 `ana_reg19.isel |= 0x3` 抑制底噪。
- **验证**：H2E/V50E/V60E 回环听感正常，无持续啸叫。

### MB12 语音回环手柄通道缺失

- **现象**：MB12 单机/联机回环中，手柄通道无声音。
- **定位**：原 i12 的回环路径语义为「path1 免提 + 开 SPK_AMP / path2 关 PA（接外接喇叭）/ path3 Line MIC1↔ROUT I2S 环」。MB12 没有 i12 转接板的「关 PA、外接喇叭」用法，手柄走片外 codec（ES8389），因此 path2 语义不适用；同时原代码被 `STANDALONE_I12` 宏绑死，开 `STANDALONE_UI` 的产品编不进同一套 loop path 代码。
- **修改**：
  - 引入门控宏，把原有回环/功放逻辑从 `CONFIG_BK_ATE_STANDALONE_I12` 改判为 `BK_ATE_I12_LOOP_PATH`（`STANDALONE_I12 || MB12_LOOP_PATH2_HANDSET`），MB12 特有行为再套 `CONFIG_BK_ATE_MB12_LOOP_PATH2_HANDSET`；
  - path2 改为 `i12_codec_route_apply(HANDSET)`：MIC 走 CHAN_1、SPK 走 CHAN_0（LOUT），与 LINE（CHAN_0 / CHAN_1）互斥关通道防混路，增益 MIC 固定约 0dB（0xBF）、OUT 跟随有效数字音量；
  - `bk_ate_ip_call.c` 中 speaker / handset 路由分别映射 `set_loop_path(1)` / `set_loop_path(2)`，会话 begin 默认 path1，voice start 后通过 `ip_call_sync_i12_path_after_start` 保留延迟期内的 path2/3，DSS3 切通路时同步音量；
  - hook 事件判定改为 **path + s_route 双条件**判「已在目标」，避免误跳过切换。
- **验证要点**：DSS3 1→2→3→1 时听筒/免提/Line 与设计表一致；压簧摘机 → path2、挂机 → path1 无二次咔哒；path2/3 缺 I2S 时钟时有明确 fail 日志；未开 HANDSET 的产品 path2 仍为「PA off」。

### MB12 单机确认键与退出键缺失

- **现象**：MB12 单机菜单物理键布局与 V50/V60 的 Soft 键不一致，进不了详情页、退不回预选；Tone 测项功放行为异常（有声无 PA 或误开第二脚）。
- **定位**：菜单只接受 `Soft4` / `OK`，而 MB12 实际键位需要 `DSS4`（`NAV_RIGHT`）；退出只认 `Soft1`，`*` 无效。Tone 功放脚准备的门控被写成 `#if CONFIG_BK_ATE_STANDALONE_I12`，而 MB12 开的是 `STANDALONE_UI`，导致单 SPK_AMP 路径被漏编；同时也解释了为什么不能简单短路 XGPIO 分支（V50/V60 只有 `SPK_AMP` 名、听筒走 xgpio）与 PA1 分支（有独立 LineOut 关断）。
- **修改**：`resolve_keymap_codes` 在 HANDSET 门控下把 `s_kc_dss4` 设为 `keycode(NAV_RIGHT)`，菜单态 `Soft4 | OK | DSS4 → show_detail()`，`'*' → bk_ate_standalone_request_preselect()`；`bk_ate_tone.c` 门控改为 `!CONFIG_BK_ATE_IP_CALL_ROUTE_XGPIO && !CONFIG_BK_ATE_STANDALONE_PA1`，与 UI 形态解耦。
- **验证要点**：DSS4 / OK / Soft4 均能进详情；`*` 能回预选；Tone 免提功放正常且无误开第二脚。

### IR-CUT 方向异常与 AW9523 并发写失败

- **现象**：Active URI 触发后滤光片切入/切出方向与预期相反；与键盘扫描并行时偶发 AW9523 写失败。
- **定位**：`aw9523_ircut_set` 的原有路径（init → gpio mode → push-pull → direction → outputs）**无锁**，与按键扫描或其它 AW9523 写并发会踩寄存器；方向映射由 HTTP 文件顶部两个 STATE 宏决定，写反即方向相反。
- **修改**：`aw9523_ircut_set` 入口加 `aw9523_lock()`、所有 return 前 `aw9523_unlock()`，脉冲 API 一并受益；方向反了只对调 `ATE_AURI_IRCUT_ON_STATE` / `OFF_STATE`。
- **验证要点**：`IRCUTON` / `IRCUTOFF` 切换方向正确；100ms 脉冲后线圈断电、长时间测温无持续发热；键盘扫描并行不再偶发写失败。

### i12 ATE 偶现按键失效

- **现象**：i12 联机回环过程中 DSS 按键偶发全部无响应。
- **定位**：工厂线程进入预选等待时**无条件**执行 `key_service_stop_all()`。若此时设备已处于 ONLINE、联机 session 已启动按键服务，服务被误停后工厂线程随即退出且不再拉起，联机回环就完全没有按键。
- **修改**：`i12_wait_preselect(&stopped_keys)` 改为——若已 ONLINE 直接返回且 `stopped_keys=0`，否则才 stop 并置 `stopped_keys=1`；退出工厂线程前若 `ONLINE && stopped_keys` 则 `key_service_start()` 恢复按键服务。
- **验证要点**：预选 → opt43 联机 → DSS3 切 path 全程键有效；已 ONLINE 再进工厂路径时日志出现 `already online, skip # hold wait`；本轮停过再进 ONLINE 时有 restart 且无 restart failed。

### USB 测试判定口径不一致

- **现象**：本地菜单跑 USB 测试显示正常，但远程工装 ATE 判 FAIL，或反之。
- **定位**：本地 xUI 只调用 `ateUsbWrite()` 看返回值，**只写不读**；远程 ATE 的 `usbTestStart` 强制先写后读，写成功才会执行读，读还要求 `strcmp` 完全一致（含 `'\0'` 语义下的长度比对）。
- **修改**：明确 BK 侧需实现写 + 读闭环判定后再上报 `test_usb_dev` + `success`。
- **同时记录了原实现的若干缺陷**：设备存在性检查支持 `sdb` 但分区扫描只匹配 `sda*`；失败路径未 `umount` 易残留挂载；`opendir("/dev")` 未判空；多次匹配时取「最后一个」分区导致结果不可预测；依赖 `system("mount/umount")` 需 busybox 与权限；挂载捷径依赖录音业务目录 `x_call_record`（BK 无录音业务不应照搬）；本地 UI 按键 press/release 若都进处理会重复触发。

### 单机 ATE 调试旁路代码清理

- **现象**：V50E/V60E 单机 ATE 调通后，上电仍可能直进单机菜单，绕过组合键与静音探测；boot 阶段存在不生效的死代码。
- **定位**：开发期遗留 `CONFIG_BK_ATE_STANDALONE_UI_DIRECT_BOOT`（上电直启单机菜单）、`CONFIG_BK_ATE_STANDALONE_UI_BOOT_ALWAYS`（未命中组合键也进菜单）、`CONFIG_BK_ATE_STANDALONE_BOOT_WIN_MS`（boot 静音探测时间窗，但 `ap_main` 实际未调用对应函数，属死代码）。
- **修改**：删除上述 3 个 Kconfig、删除 `bk_ate_boot_probe_standalone_mute_hold()` 与 `bk_ate_standalone_ui_thread_main()` 声明/实现，`ap_main.c` 启动逻辑简化为「组合键探测 → 命中则创建工厂入口线程，否则启动 xui」；静音长按检测迁入 `bk_ate_preselect_ui.c` 的预选线程内轮询（`preselect_poll_mute_hold()`）；`BK_ATE_STANDALONE_BOOT_MUTE_MS` 语义更新为「Preselect: hold mute」。共 8 文件 +8 / −167 行。
- **矩阵 GPIO 交接注意**：组合键探测成功后 `s_boot_matrix_probe_unmap_pending` 保持，不在 main 中 exit；由 `bk_ate_factory_entry_thread_main` 做显示 init → 预选首屏 → `bk_ate_matrix_probe_exit()` → `bk_ate_matrix_gpio_init(0)`；预选轮询静音前先 `bk_ate_key_service_stop_all()`，避免与 `ate_key` 线程并发 scan 导致 `held_ms` 被清零。
- **验证结论**：不按组合键进 xui；组合键 ≥2s 进预选且不启动 xui；预选长按静音进单机菜单；预选 + 网线 opt43 进联机 ATE UI；单机菜单 Soft1 回预选；H2E headless 行为不受影响。

### 移植与构建过程问题

- **git 推送/合并**：ATE 相关代码需从另一内网 Git 仓库合并到当前主分支，流程为添加远程（示例地址 `git@git.example.com:team/BK7258_ATE.git`）、`git fetch <branch>`、`git checkout -b ate-merge <remote>/<branch>`、`git rebase master`。
- **rebase 冲突**：`projects/voip-project/ap/CMakeLists.txt` 双方各自新增 include 路径 → 保留两者；`projects/voip-project/port/legacy-app_stub/dmdev/src/input_keypad.c` 按键处理实现不同 → 保留 ATE 分支的调试打印版本。
- **编译错误**：`COL_NUM` 未随配置结构改造，改为 `s_cfg.col_num` 后编译通过，并 `git commit --amend --no-edit` 并入前一提交。
- **分区不足**：编译报分区不够，调整 `projects/voip-project/partitions/bk7258` 下 `ota`（4416k）与 `userdata`（2024k）大小。
- **QEMU 验证**：使用 `qemu-system-arm -M bk7258` 加载 `app.elf` 与 `qsim flash`/`qspi1` 镜像，`-serial mon:stdio -vnc :0` 观察串口与屏幕。

## 结论、注意事项与遗留问题

**结论**

1. 音频引擎（`bk_ate_voice_echo.c`、`bk_ate_tone.c`）在 H2E / V50E / V60E 上完全共用，无机型 `#ifdef`，唯一差异是 Tone 音量上限（H2E=50，其余=48）。机型分叉集中在**路由层**：H2E 用双功放 GPIO 直控，V50E/V60E 用 xgpio 框架（GPIO21 DAC 总开关 / GPIO48 HS_AMP / GPIO49 SPK_AMP），V60E 独有 PCM `>>1` 防啸叫衰减。
2. 单机与联机的差别只在「谁触发、谁判定」：联机由工装 TCP 下发 TR、操作员按键后 RT 上报；单机由本地菜单/按键序列触发，有屏用 LVGL 反馈、无屏用静音灯闪烁反馈。
3. 音频类测试项的关键设计：回环用 2s 延时起播防啸叫，用双缓冲累加读取避免丢帧无声；Tone 用定点递推生成 600Hz 正弦免依赖 `libm`，用生产者-消费者双线程 + 48 帧 Ring Buffer + 12 帧预填充保证不卡顿、不起播 underrun。
4. 兼容性处理以「降级运行」为主：hook 检测不可用只打 WARN；路由 GPIO 缺失优雅跳过；两形态共用同一套底层引擎与协议栈。
5. 产品差异化统一用**硬件能力宏**而非 UI 形态宏来门控（如 Tone 功放门控由 `STANDALONE_I12` 改为「非 XGPIO 且非 PA1」），避免新增产品形态时漏编译路径。

**注意事项**

- 联机帧必须单次 `lwip_send`；拆包会被工装误判为半包。
- 回环起播不要在定时器服务上下文直接调用（会做 DMA 分配）；务必新建线程执行。
- `usb.txt` 写入长度应与产线既有 ATE 对齐（`strlen + 1`，含 `'\0'`），读后同样按该长度比对。
- 产线 PASS/FAIL 以 `success` 字段为准，不用屏显文案字符串做判定。
- 双稳态线圈类器件（IR-CUT）只能脉冲驱动，测试中需关注是否有持续发热。
- LED 的 PWM 目标需内核开启 `CONFIG_PWM`，否则只会打印警告并跳过。
- 删除调试入口后，单机 ATE 的唯一入口是「组合键 → 预选 → 长按静音」，产线需同步更新操作 SOP。

**遗留问题**

- `test_video_preview` 目前仅返回 success 占位，真实视频预览能力未实现。
- USB 存储测试在 BK 侧为移植参考方案，检查清单（独立实现 Write/Read、节点名适配、vfat 支持等）尚未逐项确认落地。
- 原 legacy-app USB 实现的 7 项已知缺陷（节点/分区不一致、失败未卸载、`opendir` 未判空、分区选取不确定、依赖 `system()` 工具、依赖录音目录、本地 UI 可能重复触发）需在移植时规避。
- H2E 单机回环/Tone 无 pass/fail 键，只能人工听音后用退出键结束，结果不落库。
- 回环衰减（`>>1`）为硬编码常量，未做可配置；不同硬件耦合强度是否需要分档未验证。

## 附：信息不足的源文件

| 源文件 | 情况 |
|--------|------|
| `ATE测试流程记录.txt`（由 docx 抽取） | 内容为外部 ATE 软件的操作步骤（生成订单、导入订单、开始测试）与登录账号示意，正文多为截图说明，无实现细节与调试信息，仅可提取一句参考链接（内网地址）。已按脱敏要求处理，未纳入技术流程正文。 |
