+++
title = '音频-01 无声与播放链路排查'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 1
tags = ['嵌入式', '音频', '调试排障', '硬件适配']
+++

一条测试音，七轮折腾：先是彻底无声，接着只剩沙沙声，再后来只有一个声道肯出声。等 MB12-V2 这边总算安静下来，A330i 又送来 T111054——压测约一周后通话无声；A330 的蓝牙通话（T116329）偶尔也玩失踪。下面把这几条链路和踩过的坑完整记一遍。

> 本文整理 ES8389 播放链路（BK7258 + MB12-V2 板卡）、Android AudioHAL / AudioPolicy 通话链路，以及文件描述符生命周期的技术流程与调试过程记录。
> 涉及机型：MB12-V2、A330、A330i、V67。涉及器件：ES8389、内部问题单 T111054 / T116329。
> 文中厂商名以 `Vendor` / 「本司」代替，品牌词在符号与代码路径中改写为 `vendor`，个人目录以 `~/work/repo` 代替，调试日志前缀统一写作 `dbg_`。

---

## 概述

本文只归纳两类内容：

1. **技术流程**——音频通路结构（mic / 手柄 / 免提 → codec → I2S / DSP → 输出）、音量与增益链路、通话与回环、蓝牙音频通路，以及文件描述符的打开—使用—关闭生命周期。
2. **调试过程**——按「现象 → 定位手段 → 根因 → 修改 → 验证结论」组织，覆盖手柄输出偏小、ES8389 播放无声、A330i 无声（FD 泄露）、A330 蓝牙通话偶发无声、V67 语音延迟等案例。

各机型与问题的对应关系如下：

| 平台 / 板卡 | 音频器件与总线 | 主要问题 |
|---|---|---|
| MB12-V2 | ES8389（I2C1，GPIO42/43）；BK7258 I2S3 Master（GPIO44–47） | 手柄 / LINEOUT 输出偏小；FCT 播放从完全无声到双声道正常 |
| A330 | ES8389；同为片内差分直推听筒 | 蓝牙通话偶发无声（T116329） |
| A330i | ES8389；Android 侧 AudioHAL（tinyalsa） | 压测后无声，根因 FD 泄露（T111054） |
| V67 | Android 侧 AudioHAL | 通话建立后前 3~4 秒无语音 |

**一句话概览**：硬件的隔直电容、codec 使能寄存器（DAC_MIX / S2P mute）、I2S 通道与 store_mode、Android Framework 的通信设备语义、以及 HAL 的 FD 配对，是这批问题的五个主要根因面。

---

## 音频通路结构

### ES8389 模拟输出通路（硬件）

**手柄通道**（走 LOUT，即左声道 / DAC1）：

```text
ES8389 DAC1 → LOUTP/N → C703/C706（各 1µF 隔直）→ 0Ω → Headset_Spk+/-（听筒，无外接 ClassD）
```

- 手柄**没有独立功放**，由 codec 片内 HP driver 直接驱动，原理图标称约 60mW。
- 免提走的是另一条路（BK DAC → ClassD），功率为瓦级，响度上限天然高很多，两者不能直接比响度。
- 满幅输出能力：AVDD = 3.3V 时约 **1.85 Vrms（差分）**。

**LINEOUT 通道**（走 ROUT，即右声道 / DAC2）：

```text
ES8389 DAC2 → ROUTP/N → C601/C603（各 1µF 隔直）→ EX_HA_OUT+/-
```

### 与 A330 的通路差异

| 项目 | A330 | MB12（原设计） |
|---|---|---|
| 听筒通道 | 多用 DACR / 对应输出 | LOUT / DAC1（按 MB12 原理图） |
| 听筒隔直电容 | 无（差分直连） | 有 1µF ×2 |
| 听筒驱动 | codec 差分直推 | 意图相同，但中间多了隔直电容 |

结论：MB12 手柄通道软件上应走 DACL / `CHAN_0`，不要照搬 A330 的 DACR；但真正导致「带负载很小」的是那两只 1µF 隔直电容，而不是通道选错。

### 关键使能点与寄存器

| 寄存器 / 控件 | 作用 | 要点 |
|---|---|---|
| `REG69`（`HPLSW` / `HPRSW`） | L / R 通道 HP driver 开关 | =1 开 HP driver，=0 为 lineout 模式 |
| `DAC_MIX(0x44)` | DAC → LOUT/ROUT 的 mixer 矩阵 | 默认 0x00 时所有 DAC→引脚通路关闭，表现为完全无声 |
| `DAC_REG40` bit0/bit1 | S2P mute（声道使能） | 置 0 会直接切断 DAC 到串行输出的通路，不是「音量为 0」 |
| `REG46` / `REG47` | DAC 数字音量 | `0xBF` ≈ 0dB，`0x00` ≈ -95.5dB，`0xFF` ≈ +32dB |
| `REG40`（`0x61` 等） | DAC1 解 mute | 播放前需确认已解 mute |

### Android 侧通话链路与声卡枚举

```text
Telecom / VoIP → AudioFlinger → AudioPolicyManager → Audio HAL → Bluetooth SCO
                    ↑                   ↑
              (创建 Track)       (选择输出设备、计算音量)
```

设备上共有 5 个声卡：`card0 rockchipdp0`（DP/SPDIF）、`card1 rockchiphdmi`、`card2 rockchipbt`（蓝牙）、`card3 es8389simple`（扬声器/耳机 codec）、`card4 rockchipes8389`。音频相关进程有 HAL 进程与 AudioFlinger（audioserver）。

### 文件描述符（FD）与声卡控制设备

FD 是非负整数索引，指向内核为该进程维护的打开文件表项。Linux 下「一切皆文件」，因此 `/dev/snd/controlC*` 也以 FD 形式被 HAL 持有。`controlC<card>` 只用于配置混音器、音量、路由，**不承载 PCM 数据**，正常应在用完即关。每个进程可打开的 FD 上限有限（本案例中进程上限为 32768），上限被打满后新的 `open` 会失败。

## 技术流程

### 播放侧的抽象与路由（FCT 框架）

播放不采用独立 `play_tone()`，而是抽象成「声卡 + 操作集」，由产品路由表把逻辑路由映射到声卡与声道：

```c
struct fct_snd_ops {                              /* 声卡操作集 */
    int  (*init)(void);                           /* codec + I2S 初始化 */
    void (*deinit)(void);
    int  (*play_open)(int port, int ch, int hw_gain);
    int  (*play_pcm)(const int16_t *buf, int samples, int port, int ch);
    void (*play_close)(void);
    int  (*rec_open)(int port, int ch, int hw_gain);
    int  (*rec_pcm)(int16_t *buf, int samples, int port, int ch);
    void (*rec_close)(void);
};
/* 声卡描述：name="es8389" / ops / 播放与录音增益范围 [0,63] / prefill_frames=6（预填充 60ms） */
```

MB12-V2 的两条路由：

| 路由名 | 播放声道 | 物理输出 | 录音声道 | 物理输入 |
|---|---|---|---|---|
| `line` | ch=1（右） | ROUT | ch=0（左） | MIC1 |
| `headset` | ch=0（左） | LOUT | ch=1（右） | MIC2 |

功放 GPIO 按产品表绑定：`handfree1/handfree2 → GPIO_48`（active=1）；`line`、`headset` 无功放 GPIO。

### 初始化流程与顺序约束

- **codec 必须先于 I2S 初始化**：ES8389 工作在 slave 模式且未上电时不需要 BCLK；BCLK 由 BK7258 Master 在 I2S 初始化时开始输出，此时 codec 已完成配置。
- **I2S 必须同时初始化 TX 与 RX**：Master 模式下只初始化 TX 会导致 DMA 不触发或时钟异常。
- **MCLK 来源于 BCLK**：无独立 MCLK 引脚的关键配置（`0x02=0x40`）；反初始化顺序与之相反且固定——先停 I2S → 先 RX 后 TX 释放通道 → 关闭 I2S → 下电复位 codec，RX / TX 顺序反过来可能导致下次 init 失败。

### 播放数据流：回调与数据流解耦

```text
应用层（每 10ms）           I2S 驱动层                      硬件
  |                           |                            |
  |-- play_pcm() ----------> |-- [Ring Buffer] --DMA----->|-- I2S DOUT → ES8389
  |   (mono→stereo LRLR)      |                            |
  |                           |   [DMA 消耗数据]            |
  |                           |<-- dma_cb() ---------------|
  |                           |    (keepalive? sil : nop)  |
```

- DMA 回调在播放时为 no-op；纯录音（keepalive=true）时向 ring buffer 写静音以维持 I2S 时钟。
- 应用层以 10ms 周期写入 640 字节 tone 数据；ring buffer 为 1280 字节（20ms），留出安全余量。
- 预填充（`prefill_frames=6`，60ms）在启动时写入静音，防止 DMA 断流并避免播放未预期数据。

### 采样率、缓冲区与 I2S 数据格式

| 参数 | 值 | 计算 |
|---|---|---|
| 采样率 / 位深 / 声道 | 16000 Hz / 16-bit / 2 | — |
| 每帧样本数 | 160 | `AUDIO_SR × 10ms / 1000` |
| 单帧数据量 | 640 B | 160 × 2ch × 2B |
| Ring buffer | 1280 B | 640 × 2，容纳 20ms |
| DMA 消耗速率 | 64000 B/s | 16000 × 2 × 2 |

统一使用 `I2S_LRCOM_STORE_16R16L`：一个 32-bit word 中 `[15:0] = L`、`[31:16] = R`。小端下 `int16_t` 交错数组天然满足该布局（`stereo[2i]` 为 L、`stereo[2i+1]` 为 R）。改用 `LRLR` 会导致每个样本独占一个 word、有效数据位对齐错位。

`play_pcm()` 把单声道 PCM 复制成两声道：

```c
for (i = 0; i < n; i++) {
    stereo[i * 2]     = buf[i];   /* L → CHAN_0 */
    stereo[i * 2 + 1] = buf[i];   /* R → CHAN_1 */
}
ring_buffer_write(g_es8389_tx_rb, (uint8_t *)stereo,
    (uint32_t)(n * 2 * (int)sizeof(int16_t)));
```

ES8389 侧始终两声道同时输出，`ch` 参数仅用于兼容框架；声道独立控制应通过音量寄存器或 I2S 数据（写 0）实现。

### 音量与增益链路

- **数字音量**：`REG46/47`，`0xBF` ≈ 0dB；FCT 侧 `ob_dig_gain <0–63>`，45 即约 0dB。
- **播放硬件增益映射**：`hw_gain [0,63] → DAC 音量 [0x00, 0xFF]`，即 `vol = hw_gain * 0xFF / 63`。
- **FCT 增益映射**：FCT 增益区间 [-30, 30] 线性映射到硬件区间 [0, 63]，`FCT gain=0 → hw_gain=31`。
- **测试音幅度**：`amp=0.5FS`，即相对满幅再 -6dB，属测试条件本身，不参与判断增益是否异常。

### 功放与 pop 抑制时序

功放控制抽象为 `audio_amp_enable(gpio_map, on)`，在播放开始后 **50ms**（`AMP_ENABLE_DELAY_MS`）才打开功放，避免 ES8389 上电瞬间的 pop 噪声；播放结束再关闭。

### 播放闭环完整时序

```text
T0: init()  → codec 初始化（I2C 探测 → 60+ 寄存器序列 → 0dB → 使能声道）
            → I2S init（driver_init → bk_i2s_init → TX 通道 → RX 通道 → 静音预填充 → start）
T1: rec_open()   ← ADC 增益
T2: play_open()  ← DAC 增益，keepalive=false
T3: 预填充 6 帧（60ms）
T4: 主循环 150 轮 × 10ms：play_pcm() 写 tone → rec_pcm() 读录音 → delay；T+50ms 开功放
T5: 排空残余录音（最多 10 帧 = 100ms）
T6: rec_close() → play_close() → deinit()（先停 I2S，再下电复位 codec）
```

### 蓝牙通话链路与 SCO 时序

应用/Telecom 在来电时很快切到「蓝牙耳机」（`setPreferredDevicesForStrategy` + 请求 SCO），AudioFlinger 随即为振铃/通话打开 SCO 输出流；但蓝牙协议栈的 HCI SCO 建链需要数百毫秒，于是出现「先开流、后建链」的时序窗口。AudioDeviceBroker 内部同时维护两类状态：**上层是否请求了 SCO** 与 **SCO 音频是否真的连好**，二者在重连窗口内可能不一致。

### 文件描述符生命周期（Audio HAL）

- 打开 / 关闭控制设备的接口对：`mixer_open_legacy`（打开 FD）/ `mixer_close_legacy`（关闭 FD）。
- 上层封装：`route_pcm_card_open` / `route_pcm_open` 调用 `mixer_open_legacy`，`route_pcm_close` 调用 `mixer_close_legacy`。
- 三条高风险路径：① `route_pcm_open` 成功但 `route_pcm_close` 在错误分支被跳过；② `mixer_hdmi_set_force_bypass`、`mixer_mode_set` 内部 open/close 中途异常返回（如 `mixer_get_control` 返回 NULL）；③ `alsa_route.c` 中的全局 `struct mixer *` 句柄未置 NULL 就被再次赋值，旧 FD 丢失、新 FD 累积。

## 调试过程记录（按问题分组）

### MB12 手柄 / LINEOUT 输出偏小

**现象**：手柄通道（`Headset_Spk`）播放测试音主观声音很小，示波器带负载电压很低；LINEOUT（`EX_HA_OUT` / ROUT）同样测法空载正常、带低阻负载电压塌掉。

**定位手段**：烧录含 `lo` 路由的版本后，用测试命令 + 示波器差分测量（CH1−CH2）：

```text
adev_tone 60 hs          # 手柄 LOUT
adev_tone 60 lo          # LINEOUT ROUT
ob_dig_gain spk_hd 45    # 手柄数字增益，45 ≈ 0dB
ob_dig_gain spk_lineout 45
es8389_regs
```

软件侧核查结论：通道落 `CHAN_0`（dig45 → 约 `0xBC`/`0xBF`）、`REG69` 的 `HPLSW` bit0=1、`REG40` 已解 mute、数字音量映射与手册一致——**软件 / I2S / 增益通路正常，不是主因**。

电压实测（dig=45，tone 0.5FS，理论空载差分约 0.9 Vrms）：

| 条件 | 测得电压 | 说明 |
|---|---|---|
| 空载（差分） | ≈ 0.78～0.80 Vrms | 接近理论，正常 |
| 4.7kΩ 电阻负载 | ≈ 0.7 V | 接近空载，正常 |
| 听筒 / 低阻喇叭（有 1µF） | ≈ 0.1 V，正弦几乎看不见 | 异常小 |
| 去掉 1µF 后再带低阻 | ≈ 0.7 V | 恢复正常 |

**根因**：差分 P / N 各一只 1µF 串联电容，对负载等效为 `C_eq = C/2 = 0.5µF`；其容抗 `X_C = 1/(2πf·C_eq)`，1kHz 时约 318Ω。负载 32Ω 时分压比约 `R/√(R²+X_C²)` ≈ 0.1，1kHz 测试音的大部分压降落在电容上，听筒只分到约 0.1V。从频域看，串联电容 + 负载电阻即高通滤波器，32Ω 时截止频率已到数 kHz，1kHz 恰好落在通带外。而 4.7kΩ ≫ 318Ω，行为接近空载，因此**用 4.7k 测不出该问题**，必须用接近听筒阻抗的低阻才暴露。

**修改建议**：手柄通路 `C703` / `C706` 删除或改 0Ω 短接，按 A330 的差分直连用法；若 ROUT 也推喇叭 / 听筒，`C601` / `C603` 同样处理。差分直连时 P / N 共模直流（约 VMID）在听筒两端抵消，属 BTL / 差分 HP 常规接法。

**验证结论**：去掉电容后带低阻负载恢复约 0.7V，与 A330 直连一致；有电容时改播 3～4kHz 若明显变响，可进一步坐实高通判断。注意测量必须用差分探头方式，只量单端对地大约会少一半。

### ES8389 播放：从完全无声到双声道正常

**现象**：MB12-V2 + BK7258 上播放测试音，经历完全无声、只有沙沙声、仅单声道有声等多次失败。

**七轮尝试与根因**：

| # | 做法 | 症状 | 根因 | 修复 |
|---|---|---|---|---|
| 1 | 裸 DMA 直驱 descriptor chain | 日志 `stall=286/287`，DMA 几乎立即停转 | 不能脱离框架 I2S 初始化裸用 DMA，缺少 GPIO→I2S 映射、DMA 通道分配、descriptor 绑定 | 改用框架 I2S 初始化 + ring buffer + 回调 |
| 2 | 仅初始化 TX，未初始化 RX | 有微弱沙沙声，`dma_cb=0` | Master 模式要求 TX/RX 两条 DMA 通道同时激活 | 同时初始化 TX + RX |
| 3 | 未设置 `DAC_MIX(0x44)` | 完全无声，仅功放开启瞬间 pop | `0x44` 默认 0x00，DAC→LOUT/ROUT 的 mixer 路径全关 | 初始化寄存器表内置该使能值 |
| 4 | `store_mode` 用 `LRLR` | 连底噪都没有 | 内存布局与 `16R16L` 不同，DMA 取到位对齐错误的数据 | 统一 `I2S_LRCOM_STORE_16R16L` |
| 5 | 用 `set_spk_chan_state(CHAN_X, false)` 静音 | 目标声道完全无信号 | 该接口操作 `DAC_REG40` 的 S2P mute，直接旁路 DAC，属「DAC 被旁路」而非「音量 0」 | init 时对两声道置 true，声道用 I2S 数据控制 |
| 6 | DMA 回调中直接写 tone | 回调完全不触发，预填充未被消耗 | 默认配置 `i2s_en = I2S_DISABLE`，`bk_i2s_init()` 不会自动使能 | 显式使能 I2S（现已在 init 内处理） |
| 7 | 回调与数据流解耦（最终方案） | — | — | 回调播放时 no-op；pre-fill 写静音；应用层每 10ms 写 tone |

**验证结论**：左右声道均正常输出 1kHz 正弦波。关键设计是 DMA 回调与数据写入彻底解耦，配合 1280 字节 ring buffer 与 60ms 预填充，消除断流与竞态。

**注意事项**：不要单独调用 `set_spk_chan_state(false)` 来静音，它会操作 `DAC_REG40` bits[1:0]；声道控制应通过音量寄存器或 I2S 数据（写 0）实现。此外 `REG69` 的 `HPRSW` 一并开成 HP 对手柄无实质影响（ROUT 是另一路）。

### A330i 无声：文件描述符泄露（T111054）

**现象**：设备型号 A330，版本 1.0.0.5，压测约 1 周后通话无声音，本端与对端互相听不到；进入 ATE 语音回环同样无声，铃声与提示音也无声音。

**定位手段（分层）**：

1. 日志关键词筛查：出现 `Too many open files` 即高度怀疑 FD 泄露；同类特征还有 `Could not allocate JNI Env`、`Could not allocate dup blob fd`、`Could not read input channel file descriptors from parcel`、`InputChannel is not initialized`、`Could not open input channel pair` 等。
2. HAL 错误日志定位模块：

```text
11-18 19:18:55.806 1041 641 2658 E modules.primary.audio_hal: open pcm failed:
cannot open device 0 for card 4: Too many open files,card number = 3
```

   在 HAL 源码目录 `~/work/repo/hardware/rockchip/audio/tinyalsa_hal` 中搜索该 tag 与 `open_pcm` 定义，确认 `pcm_open` 因 FD 不足失败。
3. FD 资源核查：`cat /proc/sys/fs/file-max` 看全局上限、`ulimit -n` 看进程上限、`ls /proc/<pid>/fd | wc -l` 记录数量、`ls -l /proc/<pid>/fd/` 看指向。

压测后 `ls -l /proc/<pid>/fd` 的典型输出（同一进程持有大量 controlC FD）：

```text
lrwx------ 1 audioserver audio 64 2025-11-26 13:25 9341 -> /dev/snd/controlC4
lrwx------ 1 audioserver audio 64 2025-11-28 09:55 9342 -> /dev/snd/controlC3
lrwx------ 1 audioserver audio 64 2025-11-28 09:55 9345 -> /dev/snd/controlC3
lrwx------ 1 audioserver audio 64 2025-11-26 13:26 9347 -> /dev/snd/controlC4
```

**FD 泄露特征判定**：① FD 号高达 9000+，说明累计打开量极大；② 全部指向 `/dev/snd/controlC3` 与 `/dev/snd/controlC4`（ALSA 控制接口，本应即用即关）；③ 时间戳跨 11-26 与 11-28，长期未关闭。

**操作维度复现**：以「播放 tone / 接电话（通话前—通话中—挂断后）/ 通话中切换通道」逐项对比 FD 数量。结论是：只要触发与声音相关的操作，controlC FD 就会增加且不释放；切换通道每次净增两个 FD。

**版本二分定位**：同步最新代码不复现该问题 → 说明是某次改动引入；回退到 11 月 6 日的提交未复现，切回 11 月 8 日「组听」修改版本即复现。

**根因**：新增的组听功能里有一处判断**缺少大括号**，导致无论判断条件是否成立都会再次执行 `mixer_open_legacy()`，打开 controlC 设备却不与 `mixer_close_legacy()` 配对。

**修改与验证**：给该判断补上大括号（新版已修复）。修改后再次播放 tone、拨打电话、切换通道，FD 打开后均能正常释放，无法复现泄露。

**排查方法沉淀**：凡是 `mixer_open_legacy` 的调用点，都要成对核对 `mixer_close_legacy`；泄漏点不一定在报错文件内，外部调用者打开未关同样会导致泄露。

### A330 蓝牙通话偶发无声（T116329）

**现象**：蓝牙耳机通话偶发无声，有时需「按两次」才能接听；切一次免提再切回，声音会恢复；重置或重新切换后声音也会回来。

**定位手段**：

- 抓蓝牙 HCI 日志：`adb pull /data/misc/bluetooth/logs/btsnoop_hci.log`。
- 抓语音数据（按方向限制大小后导出）：

```text
adb shell setprop vendor.dump.in.pcm.size 50
adb shell setprop vendor.dump.out.pcm.size 50
adb pull /data/vendor/audio .
adb shell "tcpdump -i any -p -s 0 -w /sdcard/voip_debug.pcap"
```

- 数据分层对比：`vendor_debug_out_raw.pcm`（下行最原始数据，判断是否在网络或对端就已静音）、`vendor_debug_out_dealt-by-apm.pcm`（经 APM 处理后，判断 APM 是否处理异常）、`vendor_debug_out_dealt-by-apm-bt.pcm`（离开 HAL 送往蓝牙协议栈前的最后一眼，是最关键对比点）。
- 状态对照：无声时与恢复后各抓一份 `dumpsys audio`、`dumpsys media.audio_policy`、`dumpsys media.audio_flinger`，并加 `dbg_` 前缀日志观察设备选择（`dbg_getDeviceForStrategy` 是否返回蓝牙 SCO 设备）、音量计算（`dbg_computeVolume` 的最终值是否为 0）与状态切换时序（`dbg_setPhoneState`）。

**排查路径与被排除项**：一度怀疑是 Stream Mute 状态泄露（第一通挂断下发 Mute，第二通接得过快，新 Track 继承了 Stream 0 在输出设备上的 -inf 状态），但后续证明：通话音量有初始化、使用的 stream 正确（走到了 VOICE_CALL / BLUETOOTH_SCO 的 volume source 逻辑）、没有证据稳定命中 `outputDesc->isMuted(volumeSource)` 分支。因此结论不是「被静音」，而是**路由语义脏了，音量逻辑只是照着错误设备执行**。

**根因**：`AudioDeviceBroker` 在 SCO 建链 / 重连的短窗口里状态不同步——`requestedCommunicationDevice()` 仍请求 `BT_SCO`，但 `preferredCommunicationDevice()` 某一瞬间返回 `null`，于是 `updateCommunicationRoute()` 把 phone strategy 切回默认通信设备；AudioPolicyManager 之后仍正常执行 `setOutputDevices()` / `updateCallRouting()` / `checkAndSetVolume()`，但前提已错，最终表现为「通话被开在错误的通信设备上」而非「音量被静音」。也解释了「切免提即恢复」：切免提触发新的路由更新，此时 SCO 已完全激活，`preferredCommunicationDevice()` 能正确返回蓝牙设备。

**修改要点**：

1. 判断是否需要启动 SCO 时，在真正通话模式下不再只看「路由是否活跃」的宽松状态，而要看真实 SCO 音频是否已连接：

```java
final boolean isBtScoActive = isInCommunicationAudioMode()
        ? isBluetoothScoAudioConnected()      /* 通话模式下只看真实 SCO 音频是否连好 */
        : isBluetoothScoActive();
if (isBluetoothScoRequested() && (!wasBtScoRequested || !isBtScoActive)) { ... }
```

   其中真实 SCO 判定需同时满足 helper 侧与框架侧状态：

```java
private boolean isBluetoothScoAudioConnected() {
    synchronized (mBluetoothAudioStateLock) {
        return mBtHelper.isBluetoothScoOn() && mBluetoothScoOn;
    }
}
```

2. 在 SCO 重连窗口内不要把通信设备从真实耳机上松掉：只要已进入通话音频模式（或 SCO 仍活跃 / 重连中）且耳机仍连接，`preferredCommunicationDevice()` 继续固定返回真实 headset device，而不是 `null`。
3. 补充：SCO 已请求但未激活时，先把路由目标预置为真实耳机设备，并区分 `strictPreferred`（用户意愿）与 `preferredCommunicationDevice`（策略设备）两层语义。

**验证结论**：修改后蓝牙接听时声音直接走蓝牙；多次复测未再复现，与该根因判断一致。同时确认 `audio_policy` 中 `bt_sco_out` 与 route 配置本身没问题，改配置无法消除「先开流、后建链」的竞态。

### V67 通话前 3~4 秒无语音

**现象**：V67 通话建立后前 3~4 秒听不到对方声音。

**已形成的定位思路（分三条线判断，逐层排除）**：

- 下行线：看 `vendor_debug_out_raw.pcm`（送往喇叭播放的最原始下行数据）。若前 3~4 秒已是全 0，说明音频在网络层或对端就已丢失，或底层根本没收到包；若有波形但喇叭无声，则更可能是驱动或硬件功放开启太慢。
- 上行线：看 `vendor_debug_in_raw.pcm`（麦克风上行最原始数据）确认麦克风在通话伊始是否正常；再看 `vendor_debug_in_final.pcm`（经 APM 处理后的最终上行数据），确认是否为回声消除 / 降噪在初始化阶段误判，把前几秒声音当噪声切掉。
- 回显控制线：看 `vendor_debug_in_loopback_left.pcm`（送入 APM 的回采数据），确认回声消除的参考信号是否正常。

**状态**：该问题目前只有定位方法，源文档未给出实测结论与根因判定，属未闭环项（见第 5 节）。

### 回连变音问题

源文档仅有一行标题，没有现象描述、定位手段与结论，**无法归纳**，见附录说明。

---

## 结论、注意事项与遗留问题

### 主要结论

1. **硬件事先要分清通道与隔直**：MB12 手柄走 LOUT / DAC1 且带 1µF 隔直；A330 听筒走 DACR 差分直连无隔直。判断响度问题时不要照搬另一机型，也不要只用 4.7kΩ 这类高阻负载测量。
2. **软件配置正确性可用空载电压证明**：dig45 + 空载差分约 0.7～0.9 Vrms，即说明 codec 输出能力与增益通路正常，无需在增益上硬抬。
3. **codec 使能类寄存器决定「无声」还是「有噪声」**：`DAC_MIX(0x44)` 全关 = 完全无声；`DAC_REG40` S2P mute = 该声道 DAC 被旁路；两者都不是音量问题。
4. **I2S 框架约束不能绕过**：TX / RX 必须同时初始化，`store_mode` 必须与内存布局匹配，I2S 必须显式使能。
5. **Android 侧「无声」不等于「被静音」**：T116329 的根因是通信设备语义在 SCO 重连窗口被清成 null，属路由问题；而 T111054 的根因是 HAL 层 FD 未配对，属资源耗尽问题。两者的日志特征与修复层次完全不同。
6. **FD 泄露的典型判据**：FD 号异常大、集中在 `/dev/snd/controlC*`、时间戳跨多日不释放，且随「播放 / 通话 / 切通道」等操作单调增长。

### 注意事项

- 测量差分输出的幅度必须用 CH1−CH2 差分方式，单端对地会大约少一半。
- `set_spk_chan_state(false)` 不是静音手段，禁止用它做声道静音。
- 功放在播放开始后 50ms 打开，用于规避上电 pop，不要提前打开。
- 排查 FD 泄露时不能只看报错文件，`open` 与 `close` 的配对要跨文件核对。

### 遗留问题

- **V67 语音延迟**：只能确认分层抓包与逐段排除的定位方法，尚无实测结论与根因判定。
- **回连变音**：源文档无有效内容，问题未展开。
- **A330i 无声**：源文档中「控制设备 FD 重复」「回退版本仍有问题」等条目缺少完整上下文；已闭环的部分（缺大括号导致重复 `mixer_open_legacy`）见 §4.3。
- LINEOUT 若最终用于驱动喇叭 / 听筒，需同步核对 `C601` / `C603` 的处置；若仅接外部 line-in 设备则可保留隔直，但容值需足够大（通常几十 µF 量级），不能再用 1µF 对低阻。

---

## 附：信息不足的源文件

| 源文件 | 内容情况 | 处理方式 |
|---|---|---|
| `回连变音问题.txt` | 仅有标题一行，无现象、无日志、无结论 | 未归纳，列为遗留项（§4.6） |
| `V67语音延迟3.txt` | 只有抓包字段含义与判断逻辑，无实测数据与根因 | 按「定位思路」收录（§4.5），明确标注未闭环 |
| `A330I无声问题确认.txt` | 片段化笔记：FD 概念、部分日志与命令、若干未完成段落（版本回退、加打印、括号问题均只有标题式记录） | 与 FD 泄露参考文档合并归纳（§3.9、§4.3），缺失部分不出现在结论中 |

### 相关文件与命令索引（脱敏后）

关键路径：ES8389 驱动 `projects/qemu_voip/port/audiodevice/es8389.c`；通道映射（手柄 = `CHAN_0`）`.../audio/chan_map_v3.h`；FCT 播放 / 回环 `ap/components/bk_thirdparty/vendor_bk_fct/src/fct_audio.c`（`CONFIG_SNDCARD_I2S_ENABLE`）；Audio HAL（tinyalsa）`~/work/repo/hardware/rockchip/audio/tinyalsa_hal`（`audio_hw.c` / `alsa_route.c`）；蓝牙 HFP 状态机 `HeadsetStateMachine.java`；通信路由决策 `AudioDeviceBroker.java`。

```text
# 板卡侧测试命令
adev_tone 60 hs | lo | hf | stop
ob_dig_gain spk_hd|spk_lineout <0-63>   # 45 ≈ 0dB
es8389_regs

# 设备侧 FD 与音频状态核查
ulimit -n / cat /proc/sys/fs/file-max / ls -l /proc/<pid>/fd/
dumpsys audio / dumpsys media.audio_policy / dumpsys media.audio_flinger
```
