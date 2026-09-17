+++
title = 'ATE-05 V60E 系列产测开发记录'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 5
tags = ['BK7258 平台', 'ATE 产测', 'LVGL', '音频', '调试排障']
series = 'ATE 产测实战'
+++

V60E 这条产测链路，我原以为只是把测项搬过去而已——结果按键得交给 keymaps.txt 管，音频则在 DMA 上下文、GPIO 路由、线程并发三个地方轮流给我下绊子。三处毛病、三张面孔，修好一个，下一个已经在排队等你了。记录如下。

> 本文整理 V60E / V50E 等机型的产测（ATE）框架、测试项流程与联调过程中的问题定位记录。
> 涉及芯片平台 BK7258（AP + CP 双核），固件工程为 `sdk-repo` / `voip-project`。
> 文中代码路径、函数名、配置项、日志片段均做脱敏处理（厂商名以 `Vendor` 代替，个人目录以 `~/work/ate` 代替）。

---

## 概述（各机型产测方案的差异）

产测框架统一位于 `bk_ate` 组件，同一套测试逻辑按机型做配置与 UI 适配。各机型差异主要体现在**屏幕、按键矩阵、keymaps 配置、UI 布局**四个维度：

| 机型 | 屏幕 | 按键矩阵 | 产测特点 |
|------|------|----------|----------|
| V60E | ST7789P3 彩屏，硬件横屏（320×240，MADCTL 0x60） | 扫描层 4×5（keycode 40–59）；单机 UI 矩阵按 keymaps 动态生成为 7×4 | 基准机型：单机 10 项菜单、联机复用同一套 LVGL |
| V50E | ST7567 黑白小屏（132×64） | 4×5（keycode 40–59） | 复用 V60E 测试逻辑，仅改小屏 UI（联机三行布局） |
| H2E | — | 4×5（keycode 40–59） | 早期验证机型，公用的 `bk_ate` 测项先在 H2E 上跑通 |

**关键差异点**

- **按键**：V60E 与 H2E 的按键矩阵完全独立，不混合使用。V60E 音量+ 为 keycode 41、音量- 为 43、静音为 42；H2E 对应为 44/54/49。差异通过各机型自己的 `keymaps.txt` 与 `CONFIG_PRODUCT_*` 编译宏区分，矩阵扫描代码（`bk_ate_key.c`）共享。
- **产品 PID**：`product_pid.json` 中 H2E=3000、V50E=3001、V60E=3002。V60E 的 PID 仅在打包阶段写入工厂镜像，不改变 ATE 协议栈（详见 §4.9）。
- **EHS 耳机测项**：先在 V60E 联机模式下完成，V50E 直接复用 `bk_ate_ehs.c` 的检测逻辑，只在 `bk_ate_standalone_ui.c` 做小屏文案与布局适配。
- **单机入口**：早期版本在 boot 阶段直接探测静音长按进入单机 ATE；V60E 改为「音量组合键 → 预选界面 → 静音长按 / opt43」的二级入口，单机与联机都必须先经过预选。

产测存在三种运行形态：

| 形态 | 触发条件 | 功能 |
|------|----------|------|
| 正常话机模式 | 上电未按组合键 | 正常通话，**不能进入任何 ATE** |
| 联机 ATE | 组合键 + DHCP Option 43 | 连 ATE 服务器，接收工装指令 |
| 单机 ATE | 组合键 + 预选界面内长按静音 | 本地菜单测试，不依赖服务器 |

---

## 架构与关键路径

### 按键驱动层次

```
应用层：xui / bk_ate_standalone_ui（处理 keyvalue）
   ↑ keyvalue（17/18/19/180…）
映射层：keymaps.txt（keymap[keycode] = keyvalue）
   ↑ keycode（40–59 及扩展码）
扫描层：bk_ate_key.c（GPIO 矩阵扫描、去抖、稳定判定）
   ↑ GPIO 电平
硬件：V60E 4×5 矩阵（行 GPIO_47/46/45/44，列 GPIO_18/19/55/54/53）
```

扫描层产生原始 keycode，映射层把 keycode 映射成逻辑 keyvalue（如 V60E 音量+ = 41 → 17）。应用层只认 keyvalue，因此换机型只需换 `keymaps.txt`，不需要改 ATE 代码。

### 核心文件与职责

| 文件 | 职责 |
|------|------|
| `ap/ap_main.c` | 组合键探测、工厂路径 `ap_bk_ate_factory_path_bringup()`、创建 `ate_ui` 线程 |
| `bk_ate/src/bk_ate_key.c` / `bk_ate_keymap.c` | 矩阵扫描与组合键探测；`keymaps.txt` 解析（含注释标签、产品名提取） |
| `bk_ate/src/bk_ate_preselect_ui.c` | 预选界面：显示、轮询静音、接收 opt43 通知 |
| `bk_ate/src/bk_ate_standalone_ui.c` | 单机测项菜单与全部子页；联机模式复用同一套 LVGL 树 |
| `bk_ate/src/bk_ate_online_ui.c` | 联机薄封装（切联机模式 + 启动 standalone UI） |
| `bk_ate/src/bk_ate_voip_display.c` | SPI LCD + `lv_vendor_init/start`；背光 PWM API |
| `bk_ate/src/bk_ate_session.c` | DHCP opt43 解析、TCP `session_run()`、断连清理 |
| `bk_ate/src/bk_ate_vendor_msg.c` | `msg=TR/CR/RC` 分发，`test_*` 与行为绑定 |
| `bk_ate/src/bk_ate_ehs.c` / `bk_ate_hook.c` / `bk_ate_ip_call.c` / `bk_ate_voice_echo.c` / `bk_ate_tone.c` / `bk_ate_led.c` | 各测试项实现 |
| `bk_ate/include/bk_ate_hw_version.h` | 各机型 GPIO 阈值表（如 EHS `HEADSET_DET_GPIO`） |
| `projects/voip-project/port/bk_ate_factory_port.c` | 工程侧 GPIO/存储/路由钩子 |
| `projects/voip-project/config/products/v60e/ap/config/bk7258_ap/config` | 机型 `CONFIG_BK_ATE_*` 超时、功能开关 |
| `projects/voip-project/config/products/v60e/ap/config/bk7258_ap/usr_gpio_cfg.h` | GPIO 默认设备表、PWM 映射表 |

### 线程与锁

- `ate_ui` 线程：`bk_ate_standalone_ui_thread_main` → `bk_ate_voip_display_init` → `build_screens` → 启动键服务。
- 键服务通过 `lv_async_call` 把按键事件投递到 LVGL 线程执行。
- `ate_key` 线程：矩阵轮询；`ate_tone_c` / `atevocdly` 等测试项工作线程。
- **LVGL 显示锁**：`lv_task_handler()` 全程持有 `lv_vendor_disp_lock`（非递归互斥），因此不能在 LVGL 持锁上下文中再次加锁（见 §4.2）。

### 配置文件与 Flash 标记

| 位置 | 内容 |
|------|------|
| `/resource/etc/default/keymap/keymaps.txt` | 机型按键映射与注释标签、产品名 |
| `/etc/led.conf` | LED GPIO 表（如 `SIDE_DSS_LED0..2`、`POWER_LED`） |
| `/etc/gpio.conf` | 功放/模拟开关 GPIO（`SPK_AMP_GPIO`、`HN_HS_AMP_GPIO` 等） |
| `sys_net` 分区 V2 布局 | 设备 MAC / SN / 产品 PID 冗余区（PID 三副本 + CRC） |
| `projects/voip-project/product_pid.json` | 机型 → PID 映射（打包脚本读取） |

---

## 技术流程

### 上电与 ATE 入口

**流程**：上电 → `ap_main` 初始化（网络、显示、延迟等待文件系统就绪）→ `bk_ate_boot_probe_factory_combo()` 探测音量+/- 组合键 → 命中则进入预选界面，未命中则启动 xui 正常话机 UI。

**V60E 超时参数**

| 配置项 | 值 | 含义 |
|--------|-----|------|
| `CONFIG_BK_ATE_BOOT_FACTORY_HOLD_MS` | 2000 | 组合键需持续按住的时长（ms） |
| `CONFIG_BK_ATE_BOOT_ABORT_WALL_MS` | 8000 | 探测窗口上限 |
| `CONFIG_BK_ATE_STANDALONE_BOOT_MUTE_MS` | 2000 | 预选界面内静音累计时长 |
| `CONFIG_BK_ATE_STANDALONE_BOOT_WIN_MS` | 12000 | 仅 boot 直探测路径的窗口（预选界面无超时） |

**组合键探测（简化）**

```c
int bk_ate_boot_probe_factory_combo(void)
{
    if (bk_ate_keymap_load() == 0) {
        factory_k_a = bk_ate_keymap_keycode_for_value(17); /* 音量+ → 41 */
        factory_k_b = bk_ate_keymap_keycode_for_value(18); /* 音量- → 43 */
    }
    while (wall_ms < win_ms) {
        matrix_scan(pressed);
        if (boot_both_raw_down(pressed, factory_k_a, factory_k_b)) {
            if (++stable_ticks >= DEBOUNCE_TICKS) held_ms += poll;
        } else {
            stable_ticks = 0; held_ms = 0;
        }
        if (held_ms >= need) return 1;   /* 命中 → 工厂/预选路径 */
        wall_ms += poll; rtos_delay_milliseconds(poll);
    }
    return 0;                            /* 未命中 → 正常话机 */
}
```

**单机静音长按进入**：组合键命中后置 `s_factory_boot_hit = 1`，扫描线程每周期调用静音长按轮询；未命中组合键时即使长按静音也不会进入单机 ATE。

**预选界面文案**：居中 `Waiting for ATE connection, please wait...`，下方 `Mute: standalone ATE` / `Ethernet: online ATE`。预选阶段既无静音长按也无有效 opt43 时，一直停留在预选界面。

**关键日志**

```
boot probe: factory combo ok ..., preselect: hold mute for standalone
ate_pre: preselect UI enter
ate_pre: preselect: mute hold -> standalone ATE UI
ate_pre: preselect: opt43 -> online ATE UI
```

**Soft1 回预选**：单机主菜单按 Soft1 调 `bk_ate_standalone_request_preselect()`，销毁单机 UI 回到预选界面；实现走「`teardown` → `preselect_ui_build` → `lv_refr_now`」，在 LVGL 持锁上下文**同步**执行（详见 §4.2）。

### 单机 ATE 测试项流程

主菜单共 10 项（`s_test_item_name[]`）：

```
Version → Keypad → LED → Hook → LCD → Reboot → Factory → Aging → Loopback → Tone
```

- 数字键 1–9 对应第 1–9 项，数字键 0（逻辑键值 10）对应第 10 项；上下键移动高亮；Soft4 确认进入。
- 子页默认：`*` 与 Soft1 返回主菜单；`0` / `#` 显示居中结果浮层后约 1.8 s 自动回主菜单（结果定时器 `led_result_menu_timer_cb` 支持 LED / LCD / Loopback / Tone 多项）。

**Keypad（按键）测项**

- 矩阵从 `keymaps.txt` 动态生成：收集有效条目 → 按 keyvalue 升序排序 → 计算行列数（>20 键用 5 列，否则 4 列），并提取注释标签与产品名。
- 命中后**原位消隐**：清空格子内 label 文字并把背景/文字透明度置为透明，**不使用 `LV_OBJ_FLAG_HIDDEN`**，避免 flex 子项移除后整行重排。
- 进入子页后约 **150 ms 武装延迟**（`s_keypad_matrix_armed = 0`），期间按键不消隐，避开进入当次与紧随的误触；离开子页删除定时器并复位。
- 全部按毕打印通过横幅并弹英文浮层 `Test result: PASS`，约 2 s 后回主菜单；未全按完离开时打印「未完成」。

**LED 测项**

- 单机不自动闪烁：`prepare_standalone` 读 `/etc/led.conf`、初始化 GPIO 并关灯；按任意键后 `start_blink` / 常亮换色（每按一次全局相位 +1，双色红/绿互换、单色亮/灭互换）。
- `0` / `#` 显示 `Test result: Failed / Passed` 浮层，1.8 s 后自动回菜单，`*` / Soft1 可提前返回。
- 联机仍走 `bk_ate_led_key_report`（`#`→success RT，`*`→failed RT）。

**LCD 测项**

- 首屏英文 `LCD test start`；免提键在 **7 纯色（红/绿/蓝/白/黑/黄/青）+ 棋盘** 共 8 画间循环。
- 数字 1 调背光：8 档 PWM，`idx==0` 停 PWM 且 GPIO 拉低，`idx=1..7` 占空比 `duty = period * idx / 7`；按键为**相对减一档**（`(idx+7)%8`，7→…→0→7）。
- 铺满屏策略经历多轮迭代：根屏与子页用 LVGL 逻辑分辨率 `lv_obj_set_size`，测相子项 `FLOATING` + `TOP_LEFT` + `w×h`，非当前相加 `HIDDEN | IGNORE_LAYOUT`；7 纯色最终改走与棋盘相同的 **`lv_canvas` + RGB565 缓冲**路径（详见 §4.6）。

**Loopback / Tone 测项**

- Loopback：`bk_ate_ip_call_test_session_begin` + `bk_ate_voice_echo` 起 PCM 回环；免提键切 GPIO 路由，音量± 调播放增益；离开时 `test_session_end`。
- Tone：单机进页即在**手柄**通道起播，免提键在手柄↔免提间切换通道（非播放/暂停）；联机逻辑未改。

### 联机 ATE 流程

- **触发**：插网线且 DHCP ACK 的 Option 43 载荷中含 `Vendor_ATE=` 时判定为联机路径；`bk_ate_session.c` 解析成功后调 `bk_ate_preselect_on_opt43_valid()` → `bk_ate_online_ui_start()`（置联机模式 + 启 standalone UI），主屏显示「等待连接」，后台 `session_run()` 与工装建 TCP。
- 显示复用单机 LVGL：联机仅主屏不同（`Waiting for connection, please wait...`），测项子页与单机一致。
- **测项之间无顺序、无耦合**：工装下发哪一项的 `start` 就进哪一项子页，结束（收到 `finished` 或本机发 RT）后回联机等待主屏。

**cmd → 单机子页映射（`bk_ate_ui_cmd_to_det`）**

| cmd | 子页 |
|-----|------|
| `test_keypad` | Keypad |
| `test_hook` | Spring（插簧） |
| `test_lcd` | LCD |
| `test_led` | LED |
| `test_tone` | Tone |
| `test_ip_call` / `test_voice_echo` | Loopback |
| `test_aging` | Aging |
| `test_version` | Version |

`test_hardware_info` 等即时上报项不开子页；未实现的 cmd 走协议占位 RT。

**协议处理链路**：`bk_ate_session.c` 的 `session_run()` 与 UI 并行；`bk_ate_vendor_msg.c` 收到 `TR action=start` 后启动测项后端并调 `bk_ate_ui_online_try_enter_test(cmd)` 进子页；通过/失败发 `msg=RT&...` 后回等待主屏；`action=finished` 停后端并回等待主屏。

**联机版本上报**：`test_hardware_info` / `test_version` 改为自定义处理，`action=start` 时上报 `model / appver / sysver / mac`（读 `bk_ate_proto_get_identity()` 与以太网 MAC）。

### EHS 耳机测项（V60E / V50E）

**需求**：通过 ADC 检测 `HEADSET_DET_GPIO` 插拔/开关状态；产线用 EHS 治具（耳机常插），按治具按钮 **2 次**自动通过；协议对齐工装（参考 V62W / rk3506）。

**检测逻辑**

1. `TR test_ehs start` → 开 micbias（`bk_aud_adc_init`）→ 启动轮询线程。
2. 读 SAR ADC ch14（`HEADSET_DET_GPIO`），raw 在 `50..420` 视为 inserted（阈值对齐 gpio.conf）。
3. 状态稳定变化时上报 RT，**仅上报 `status=closed`**（模拟治具按键）；松手恢复 inserted 时**不**上报 `opened`。
4. `TR test_ehs finished` → 停轮询 → 释放 `aud_adc` → 清 notify 回调 → 回 `reason=ate_ehs`。
5. Session 断连 / 离开 EHS 子页 → `bk_ate_ehs_set_notify(NULL)`（与 `test_hook` 对齐）。

**协议格式**

```
# 每次按治具按钮
msg=RT&cmd=test_ehs&status=closed

# 工装计满 2 次 closed 后
msg=TR&cmd=test_ehs&action=finished

# 设备应答
msg=RT&cmd=test_ehs&result=success&reason=ate_ehs
```

**V50E 小屏适配（仅 `bk_ate_standalone_ui.c`）**：`DET_ONL_EHS` 加入小屏联机三行布局；正文 `Press EHS 2x`、失败标题 `EHS Failed`、事件 `EHS pressed`；V60E 彩屏保持 `Press EHS button twice` / `EHS button pressed`。测试逻辑与 ADC 路径完全复用。

**预期小屏显示**

```
顶栏: EHS  00:xx
中间: Prod: V50E
      Press EHS 2x      ← 初始提示
      EHS pressed       ← 每次按键后刷新
```

---

## 调试过程记录

### 组合键探测调用过早导致崩溃

- **现象**：LVGL 初始化后立即调用 `bk_ate_boot_probe_factory_combo()`，在 `fopen()` 处崩溃。
- **定位/根因**：VFS / LittleFS 的文件系统互斥锁尚未初始化，`keymaps.txt` 加载访问未就绪的锁。
- **修改**：在 `ap_main.c` 中 `bk_ate_boot_probe_factory_combo()` 之前增加 **300 ms 延迟**，等文件系统完全就绪再探测。
- **结论**：入口探测必须晚于文件系统初始化。

### 单机 Soft1 返回预选：崩溃与死锁（两次修复）

- **现象 1（崩溃）**：从单机主菜单 Soft1 回预选，第二次操作时断言 `Assert at: lv_obj_get_screen:292`。
- **原因 1**：工厂线程在**非 LVGL 线程**调用 `teardown` 删屏，与 `lv_async_call` 按键处理竞态；删屏后 `lv_scr_act()` 仍指向已释放对象；定时器回调裸用 `lv_scr_act() != s_root_detail` 也会触发断言。
- **修改 1**：`lv_async_call` 在 LVGL 线程执行 `teardown`；`teardown` 先停键服务、加载过渡空白屏再删菜单/详情；新增 `ate_ui_scr_is()` 校验对象有效性，定时器回调改用该判断。
- **现象 2（死锁/卡住）**：Soft1 后画面仍停在单机主菜单，日志无「exited → preselect again」。
- **原因 2**：`lv_task_handler()` 全程已持有 `lv_vendor_disp_lock`（非递归互斥），再在 `lv_async_call` 回调里二次加锁会自死锁，`teardown` / 预选切屏未执行。
- **修改 2**：主菜单 Soft1 在 LVGL 持锁上下文**同步**调用 `preselect_exit_standalone_core()`（`teardown` → `preselect_ui_build` → `lv_refr_now`），不再走 `lv_async_call`；`teardown` 内部不加锁；`preselect_session_run` 若已有预选根屏则跳过重复 build。
- **结论**：非递归显示锁下，切屏动作必须在已持锁的 LVGL 上下文同步完成。

### ATE 界面竖屏与 XUI 横屏不一致

- **现象**：烧录后 ATE 测试界面（预选/单机）为竖屏，退出进 XUI 为正常横屏。
- **定位**：V60E 面板 `ST7789P3` 配置为 `HW_LANDSCAPE=y`，驱动层 `lcd_device` 为 320×240、MADCTL 0x60（硬件横屏）。XUI 路径 `xui_lvglScrn_draw.c` → `lvgl_spi_display_init()` 按宏选择 `ROTATE_NONE`；ATE 路径 `bk_ate_voip_display_init()` **写死 `ROTATE_270`**，未跟硬件横屏。
- **根因**：`ROTATE_270` 下 LVGL 逻辑分辨率被变为 240×320，flush 再做软件旋转写入 320×240 帧缓冲，表现为竖屏布局异常。两条 LVGL 初始化路径参数不一致。
- **修改**（`bk_ate_voip_display.c`）：

```c
#if CONFIG_LCD_SPI_ST7789P3_HW_LANDSCAPE
    cfg.rotation = ROTATE_NONE;
#else
    cfg.rotation = ROTATE_270;
#endif
```

- **验证**：音量+/- 进预选、静音进单机、Soft1 回预选再进 XUI，方向均正常，无二次旋转错乱。

### Keypad 格子重排 / 矩阵硬编码

- **现象**：按下某键后格消失，其余键位置整体移动；子页除矩阵外仍有英文说明；矩阵末尾仍要求 V60E 并不存在的键码。
- **根因**：消隐使用 `LV_OBJ_FLAG_HIDDEN`，flex 子项被移除后整行重排；矩阵与标签为编译期硬编码。
- **修改**：改为**原位消隐**（只清内层 label 文字与 opa，外框 slot 固定占位）；`DET_KEY` 下隐藏标题/产品/正文/底栏，仅矩阵拉伸显示；新增约 150 ms 武装延迟；矩阵、标签、产品名全部改为运行时从 `keymaps.txt` 动态读取，移除 `CONFIG_BK_ATE_KEYPAD_MATRIX_*` 等编译宏依赖。
- **验证**：实机日志确认按毕自动回菜单，浮层文案与配色正常。

### 单机 LED：GPIO27 缺表与结果自动回菜单

- **现象**：日志 `GPIO27 not found in GPIO_DEFAULT_DEV_CONFIG table`；`led.conf` 中 `SIDE_DSS_LED2` 第二路为 GPIO27，但 V60E `usr_gpio_cfg.h` 的默认设备表从 GPIO_26 直接跳到 GPIO_28。
- **根因**：HAL 无法按设备表初始化该脚，双色 DSS3 只剩一路可控。
- **修改**：在 V60E AP 的 `usr_gpio_cfg.h` 增加 `GPIO_27`（`GPIO_DEV_INVALID`，可作普通 GPIO）；`0` / `#` 显示结果浮层后启动 1800 ms 单次定时器回主菜单，`*` / Soft1 可提前返回，`detail_leave` 中取消未触发定时器。
- **附带结论**：连续两次按换色键灯态不同属**正常**（全局相位每次 +1，双色互换）。

### 单机 LCD：纯色不铺满（多轮迭代）

- **现象**：纯色相未铺满屏，底部/左侧留白；棋盘却能满屏。
- **定位过程**：
  1. 子页 `pad_all=0` + `s_lcd_area` `LV_PCT(100)` 仍留白。
  2. 改为逻辑分辨率 `lv_obj_set_size(dw, dh)` 后底边仍露白——**根因**：`s_lcd_area` 为列 flex，`s_lcd_intro / s_lcd_solid / s_lcd_canvas` 都带 `flex_grow(1)`，而 LVGL 中 `HIDDEN` 子对象**仍参与 flex 高度分配**。
  3. 修改：`lcd_refresh_phase_ui` 每相复位残留 `FLOATING`，对当前不显示的子项加 `HIDDEN | IGNORE_LAYOUT`，显示相用 `FLOATING` + 逻辑 `w×h` + `TOP_LEFT`。
  4. 仍不铺满：`s_lcd_solid`（`lv_obj`）仅靠 `bg` 样式绘制底边露白，而 `lv_canvas`（LVGL 9 基类为 `lv_image`）按 RGB565 缓冲绘制始终满屏。
- **最终修改**：7 纯色改为与棋盘同路径——`lcd_ensure_lcd_cb_buf(w,h)` 申请共用缓冲，`lv_color_to_u16(color)` 逐像素填充，`lv_canvas_set_buffer(..., LV_COLOR_FORMAT_NATIVE)`；`malloc` 失败才退回 `s_lcd_solid` + `bg`。缓冲申请前做 `w*h*2` 溢出判断。
- **验证**：实机纯色与棋盘均满屏。

### 烧录后起不来、串口反复从初始化打头循环

- **现象**：烧录后无法启动，日志在 CP0/AP1 初始化与 `create event` 附近反复从头打印。
- **分析**：`bk_init` 时间戳在 AP0 与 AP1 上不一致，怀疑**仅刷了部分分区 / 双核镜像不同步**。曾尝试在 `bk_event/event.c` 增加 CPU1 自旋等待 `s_event_inited` 的 SMP 补丁。
- **结论**：SMP 补丁实机仍起不来，且存在 CPU1 忙等而 CPU0 依赖 CPU1 推进的**跨核死锁**风险，**已整段撤回**，恢复 SDK 原版逻辑。LCD/背光等 ATE 改动在 `ate_ui` 线程内执行，晚于 `bk_init` / `create event`，不是该循环的直接触发点；反复重启应优先查**烧录完整性**与**双核固件同源**。

### 单机 Loopback：进页崩溃、无声音

- **现象**：进入 Loopback 约 2 s 后崩溃，串口出现 `aud_adc_dma_deconfig` … `invalid heap pointer 0xdededede`，位于 CPU1 / Tmr Svc；且无回环声。
- **根因**：`bk_ate_ip_call.c` 原在 one-shot 定时器回调（FreeRTOS 定时器服务任务）里直接调用 `bk_ate_app_voice_echo_start()` → `audio_record_open` → `bk_fixed_dma_alloc`。SDK 规定 DMA 分配须在**任务上下文**，在定时器服务任务中调用导致未定义行为/堆损坏。
- **修改**：
  - `bk_ate_ip_call.c` 定时器回调只创建线程 `atevocdly`，由线程在任务上下文起环。
  - `onboard_mic_record.c`：`priv` 分配后 memset；DMA 改为 `bk_dma_alloc(DMA_DEV_AUDIO)`（原 `bk_fixed_dma_alloc(..., DMA_ID_1)` 与整机 DMA1 冲突）；`adc_dma_id` 初值 `DMA_ID_MAX`，`deconfig` 仅在合法 id 时执行；open/start 失败时释放 `priv` 并清理全局记录。
  - `onboard_speaker_play.c` 与 mic 对称修复（`bk_dma_alloc`、`dac_dma_id` 守卫、失败收尾）。
  - `bk_ate_voice_echo.c`：先 `audio_record_open` 再 `audio_play_create/open`。
- **验证**：抓串口出现 `voice loop started … (task ctx)`，不再断言。

### Loopback 响一下就无声（`strstr` 子串匹配 + mic 切换 + 忙等丢数据）

- **现象**：进 Loopback 响一下（功放 pop）后再操作就没声；日志 `hn_hs_amp_gpio_set` 始终返回 -1，但 `gpio.conf` 明确有 `HN_HS_AMP_GPIO:0,48`。
- **根因一（子串匹配）**：`x_gpio_ctrl.c` 的 `loadCustomGpioInfo()` 用 `strstr()` 匹配键名，`map[]` 中 `HS_AMP_GPIO` 排在 `HN_HS_AMP_GPIO` 前，`strstr("HN_HS_AMP_GPIO:0,48","HS_AMP_GPIO")` 先命中短键，导致 GPIO48 被写到错误的表项，`getGpioIndex(HN_HS_AMP_GPIO)` 为 -1。同类 BUG：`RF433_FCSB_GPIO` 被 `RF433_CSB_GPIO` 抢先匹配。
- **根因二（不存在的 GPIO 不应报错）**：`route_apply()` 对所有 GPIO 无条件调用 `xgpio_or_fallback()`，V60E 本就没有 `HS_AMP_GPIO`，每次切通道都报 ERROR。
- **根因三（真正的无声原因）**：V60E 有 `HF_HSHN_MIC_GPIO:0,20`（mic 模拟开关），但 `route_apply()` 未做 mic 切换；GPIO_20 默认 LOW 采集的是未连接的 handset mic 输入（静音）。
- **根因四（数据丢失）**：`voice_loop_thread` 用非阻塞 `rb_read(...,0)`，返回不足 640 B 就 `continue` 丢数据并忙等，永远凑不齐一帧。
- **修改**：
  1. `x_gpio_ctrl.c` 重排 `map[]`，长键/含子串键排前；`line_buf` 48→128 字节，新增前导空白跳过。
  2. V60E defconfig 增加 `CONFIG_BK_ATE_IP_CALL_XGPIO_HN_HS_AMP=48` 兜底。
  3. `bk_ate_ip_call.c` 新增 `xgpio_present()`，不存在则跳过；ERROR 降级为 INFO；新增 `hf_hshn_mic_gpio_set()` 切换 mic 模拟开关。
  4. `bk_ate_voice_echo.c` 重写读循环：累积部分读到 `filled` 偏移，满帧才写；`r==0` 时 2 ms yield；写失败重试；ping-pong 双缓冲；前 3 帧打诊断日志。
- **验证**：修复后预期日志 `gpio.conf: SPK_AMP=49 HN_HS_SWITCH=21 HS_AMP=-1 HN_HS_AMP=48`，切通道不再报错，回环输出 `vloop #1 ok (640 B)` 等，手柄/免提均有声。

### Tone 无声、崩溃与手柄无声

- **Tone 无声**：V60E `gpio.conf` 只有 `SPK_AMP_GPIO` + `HN_HS_AMP_GPIO`，无 `HS_AMP_GPIO`；原 `tone_amp_gpio_prepare` 要求双功放表项齐全，导致功放从未打开。改为复用 Loopback 的 xgpio 路由（`bk_ate_ip_call_route_apply_speaker()`），`audio_play_open` 前先配路由，open 后加 50 ms 等待。
- **Tone 崩溃**：`ate_key` 线程调 `audio_play_set_volume`，`ate_tone_c` 线程同时 `audio_play_write_data`，堆损坏后 LVGL 访问崩溃；`bk_ate_app_tone_stop` 在 consumer 未退出时即 `audio_play_close`。修改：增加 `s_play_mtx` 对写帧/设音量/起停加锁；stop 改为「先 `s_run=0` + `rb_abort` → 等线程结束 → 再 close/destroy」。
- **手柄无声（关键根因）**：V60E 的 GPIO21（`HN_HS_SWITCH`）**不是手柄/免提切换开关**，而是 **DAC 模拟输出总使能**——LOW 连通、HIGH 断开；真正路由由 GPIO48（手柄功放）/ GPIO49（免提功放）决定。原 REVERSE 枚举 `GPIO_HN_PLAY = 1`，手柄路由时把 GPIO21 置 HIGH，DAC 输出被切断，故手柄无声、免提有声。

```c
/* x_gpio_ctrl.h 修复前后 */
// 修复前（错误）
GPIO_HS_PLAY = 0,
GPIO_HN_PLAY = 1,   // 手柄路由 → GPIO21=HIGH → DAC 断开
// 修复后（正确）
GPIO_HS_PLAY = 0,
GPIO_HN_PLAY = 0,   // 两条路由均保持 LOW，DAC 始终连通
```

- **验证**：修复后 `route verify(out): GPIO21=0(switch) GPIO48=1(hs_amp) GPIO49=0(spk_amp)`（手柄）与 `GPIO48=0 / GPIO49=1`（免提）回读正确，手柄与免提均有声。诊断从 `bk_gpio_get_input` 改为 `bk_gpio_get_output`（OUTPUT 模式读输入寄存器不准）。
- **耳机通道说明**：当前 ATE 音频路由仅手柄与免提两路，**不支持耳机独立通道**；耳机键在 tone/loopback 代码中未处理，按下无效。

### EHS 耳机测项联调（5 个问题）

1. **检测不到插拔**：ADC 有数但 raw 不变。原因：未开 micbias（检测电路无供电）、用 mV 比阈值、内置阈值与 gpio.conf 不一致。修改：新增 `ehs_micbias_ensure()` 调 `bk_aud_adc_init`；改用 raw 判断（`raw >= 50 && raw <= 420`）。
2. **工装收到事件但不 PASS**：上报字段错误——工装 EHS 项认的是 `status=opened/closed`，不是 `event=ehs_in/ehs_out`。修改：改为 `msg=RT&cmd=test_ehs&status=closed`。
3. **按一次按钮就通过**：工装计 2 次 `closed`；一次按键产生 `closed`（按下）+ `opened`（松手）两个事件，误触发 PASS。修改：**仅上报 `closed`**，松手恢复 inserted 时只打日志 `back to inserted (no RT)`。V62W 参考日志为两次 `closed` 后 `TR finished → PASS`。
4. **EHS 后语音回环首次失败**：EHS 开 `aud_adc`（micbias）后 stop 时未 deinit，回环再次 `bk_aud_adc_init`（16 kHz）冲突，日志 `aud adc is init already` / `mic_adc_config fail`。修改：`bk_ate_ehs_test_stop()` 增加 `ehs_micbias_release()`。修复后 `micbias: aud adc released for next audio test` → `voice echo started`。
5. **Session 关闭时 EHS notify 未清理**：`bk_ate_ui_on_session_closed()` 只清了 hook 的 notify，EHS 的 `s_notify_cb` 仍指向 UI 回调，轮询线程未完全退出时可能向已销毁 UI 上下文投 `lv_async_call`。修改：`bk_ate_ehs_test_stop()` 开头置 `s_notify_cb = NULL`；`bk_ate_ui_on_session_closed()` 增加 `bk_ate_ehs_set_notify(NULL)`（对齐 `test_hook` 双点清理）。

**验证结果**

| 场景 | 结论 |
|------|------|
| V60E EHS（10-22） | 2 次 `status=closed` → `TR finished` → PASS；紧接语音回环首次即 PASS（~11 s） |
| V60E 回归（10-52，含 notify 修复） | 连续 2 轮完整联测，EHS 均 2 次 closed → PASS，`test_ip_call` 首次即 PASS；ADC `fail=0` |
| V50E 联机（11-39，小屏适配后） | 协议双边对齐（`model=V50E pid=3001`）、4 次 EHS 运行 `fail=0`、`aud adc released` 后回环首次成功 |

V50E 第 1/2 轮完整联测中 Tone / LED / LCD / 版本检查 / 插簧 / 按键均 PASS；写入证书因工装环境缺少 `.pem` 文件失败，与 EHS 无关。

### 图标与机型杂项（记录性）

- **产品 PID 提交**：`product_pid.json` 由 OTA 包头增加 pid 字段的提交引入，最初仅 H2E/V50E；后续两个提交在 `sys_net` Flash 冗余区（V2 布局，PID 三副本 + CRC，tag `0x68686868`）落地可读产品 PID，并在打包脚本中把 `PRODUCT` 对应 PID 写入**工厂镜像**（`all-app-factory.bin`）；V60E 仅新增 `"V60E": "3002"` 一行配置。**注意**：该链路与 ATE `connect` 里的 `pid=` 字段是不同链路，ATE 首包的 pid 仍是协议占位，未在本次范围内修改。写 PID 默认关闭，日常镜像不打 PID。
- **Rebase 冲突决议**：`usr_gpio_cfg.h` 冲突保留本地 ATE 侧 GPIO 表（侧键 LED 需 GPIO27，I2S MCLK 用 GPIO28）；`post/keypad/post_keypad.c` 旧路径被上游迁移至 board 层，决议 `git rm` 旧路径，沿用上游 board 层 keypad 结构，POST/AP 矩阵键仍由 `bk_ate_key` / 工厂 port 负责。

---

## 结论、注意事项与遗留问题

### 结论

1. V60E 产测确立了「组合键 → 预选界面 → 单机 / 联机」的统一入口，单机与联机**共用同一套 LVGL 树**，联机仅主屏不同、测项之间无顺序耦合。
2. 按键、矩阵、标签、产品名全部由设备侧 `keymaps.txt` 驱动，换机型只需换配置文件，不需改 ATE 代码，也不需切换编译宏。
3. 音频类测项（Loopback / Tone）的问题集中在三处：**DMA 分配上下文**、**GPIO 键名匹配与路由**、**线程间并发**，均已有明确修复手段。
4. EHS 测项在 V60E 联机模式完成联调，V50E 通过复用逻辑 + 小屏 UI 适配即可通过，证明该实现的可移植性。

### 注意事项

- **组合键是唯一入口**：未命中音量组合键时，长按静音也不会进入任何 ATE。
- **功能宏与 UI 联动**：`CONFIG_BK_ATE_LED_VOIP`、`CONFIG_BK_ATE_VOICE_ECHO`、`CONFIG_BK_ATE_TONE`、`CONFIG_PWM` / `CONFIG_BK_ATE_STANDALONE_LCD_BACKLIGHT_PWM` 未打开时，对应子页会退化为桩或「Requires …」提示；改配置后必须重新编译烧录。
- **GPIO 默认设备表**：`usr_gpio_cfg.h` 中缺失的 GPIO 会导致对应外设异常（如 LED 双色只剩一路）；`gpio.conf` 键名存在子串包含关系时，解析必须长键优先。
- **显示锁为非递归互斥**：切屏/删屏必须在已持锁的 LVGL 上下文同步完成，避免二次加锁死锁。
- **DMA 分配必须在任务上下文**：定时器服务任务中不可直接调用音频 open（会触发 `bk_fixed_dma_alloc`）。
- **音频资源互斥**：EHS 打开的 `aud_adc`（micbias）必须在停止时释放，否则影响后续语音回环。
- **烧录完整性**：双核固件需同源整包烧录，避免起机循环误判为软件缺陷。

### 遗留问题

| 项 | 说明 |
|----|------|
| V60E 小屏联机布局 | `DET_ONL_EHS` 接入小屏三行布局；V50E 已完成，V60E 侧待跟进 |
| 单机 EHS | 当前仅实现联机 EHS，单机模式待做 |
| EHS start 失败路径 | 线程/信号量创建失败时未释放 micbias，优先级低 |
| 耳机独立通道 | ATE 音频仅手柄/免提两路，耳机键无效，需新增 GPIO 定义与路由分支 |
| ATE connect 的 pid | 首包 pid 仍为协议占位，需读真实产品 PID 单独修改 |
| LCD 背光 PWM 引脚复用 | 产线若需同时点屏+测灯，需确认 LCD 与 LED 复用管脚是否应 unmap |

---

## 附：信息不足的源文件

本次通读的 4 个源文件均有实质内容，无信息不足项：

| 源文件 | 说明 |
|--------|------|
| `V60E_ATE_流程梳理.md` | 内容最完整（按键架构、入口流程、单机各测项、§9 问答迭代、§10 Standalone UI 附录与修订记录） |
| `V60E_ATE_记录.md` | 补充入口行为、UI 工程变更、Rebase 冲突、三提交梳理、横屏问题与 PID 提交分析 |
| `V60E_EHS_ATE_开发记录.md` | V60E EHS 测项需求、实现、5 个问题与验证结论 |
| `V60E_V50E_EHS_ATE_开发记录.md` | 在 V60E 基础上增加 V50E 小屏适配与双边验证数据 |
