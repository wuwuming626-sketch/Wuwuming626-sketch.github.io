+++
title = '摄像头与视频-01 出图与编码链路'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 3
+++

1280×720 直连，0 帧。不是慢，是彻底不出图——同一个摄像头在 864×480@30 上跑得好好的，分辨率一拉高就哑火。先改时分复用，勉强挤出 ~4fps；直到换成 SRAM 滚动 EM 直连，才一口气冲到 ~29fps。这条从采集、编码到 RTSP 的路，下面按站点记一遍。

> 本文整理自内部技术笔记与提交说明（2026-08 至 2026-09），覆盖 BK7258（AP + CP）平台上 I602 / I602K 板卡的 DVP 摄像头（传感器 GC2145）从采集、编码到 RTSP 推流的出图链路，以及开发过程中的调试记录。
> 文中已按脱敏要求处理厂商名、人名、邮箱与内网地址；保留产品型号、器件型号、内部问题单号、代码路径与函数名、提交 SHA。文档与注释仅供参考，与源码冲突时以源码为准。

## 概述

### 目标与阶段演进

| 阶段 | 目标 | 结果 |
|------|------|------|
| 480P 联调 | GC2145 + DVP + MJPEG 硬件编码 + RTSP 推流跑通 | 864×480@30 稳定出图（`ae63ef247`、`1100a96ee946434c4a7424fb90529cdf45a51218`） |
| 720P 出图 | 1280×720 出图 | 直连编码器方案长期 **0 帧**；改为「采集→内存→nosensor 编码」时分复用后 MJPEG ~4fps（`6f6435a39`） |
| 高帧率直连 | Sensor → yuv_buf → H264 直连、无软件时分复用，逼近 30fps | 达到 ~29fps（`b6e4366ad3d2f9743d3c9122f61d1019f5f7b194`） |
| 另一工程形态 | 把 IP-Cam 式采集 + RTSP 能力移植进 qemu_voip（H2E 等） | CLI 按需启动，默认开机不推流 |

### 两类代码落点

| 形态 | 目录 / CLI | 说明 |
|------|-----------|------|
| I602 Demo | `projects/qemu_voip/ap/camera_rtsp_test/`，`cam_test start\|stop\|status` | 默认 864×480 MJPEG@30，RTSP 7070 |
| qemu_voip 移植版 | `qemu_voip/ap/video_ip_cam/`，`dvp_start` / `uvc_start` / `rtsp_start` / `ip_cam_start` 等 | 与 IP-Cam demo 同源 RTSP/RTP，默认不启 |

出图链路的矛盾集中在一点：**传感器是「突发式」的输入端，编码器是「匀速」的消费端**。所有技术方案与调试记录，都是在这两端的速率、缓冲深度与错误恢复策略之间取舍。

## 出图通路结构

### 结构 A：直连（Sensor → yuv_buf → 编码器）

```text
GC2145 (DVP 8bit)
   │  MCLK / PCLK / HSYNC / VSYNC / DATA[7:0]
   ▼
yuv_buf（内部 FIFO 或 EM 滚动缓冲：SM0 / SM1 各 16 行）
   │  行级直读
   ▼
JPEG / H264 硬件编码器 ──FINAL_OUT / EOF──► 帧队列 ──► RTP / RTSP
```

特点：链路最短、无 CPU 搬运；但对 **行级实时匹配** 极敏感——sensor 边写 16 行，编码器边抽 16 行，任一端慢半拍就会 `sensor fifo is full` 或整帧卡死。

### 结构 B：时分复用（TDM，绕开 FIFO）

```text
采集相：GC2145 ──YUV 模式──► yuv_buf ──DMA 直写──► 内存池槽位（2 × 1.8MB，乒乓）
编码相：consumer 线程把 yuv_buf 切到 nosensor 模式
        编码器 ──从 em_base_addr 读内存──► JPEG / H264 码流 ──► RTP
然后切回采集相 → 循环
```

特点：`enable_nosensor_encode_mode()` 把编码器输入源由「sensor FIFO」换成「内存地址」，软件在 `JPEG_LINE_CLEAR` / `H264 LINE_DONE` 中断里按 8~16 行一段喂数，**喂多快由软件决定**，FIFO 不会再被灌爆；代价是采集与编码互斥，编码期间丢掉 sensor 帧。

### 结构 C：解码 + 显示（下位显示通路）

`码流 → JPEG 硬解 → YUV422 → lv_dma2d_yuv_pfc_to_rgb565_inset → RGB565 → LCD(1024×600) 渲染`。

该通路服务于「摄像头画面显示到屏幕」，与推流链路共用编码后的码流，但对内存（SRAM / PSRAM slab）的占用另有独立账目，见 §4.11。

### 软件分层与角色

| 角色 | 上下文 | 职责 | 硬约束 |
|------|--------|------|--------|
| DVP / DMA / JPEG 完成路径 | 中断或驱动回调侧 | 触发 `malloc` / `complete` | **禁止阻塞、禁止长耗时、禁止日志洪泛** |
| `dev_dvp_camera` 回调 | 同上 | 对接 `frame_queue_v2_*` | 失败必须 `cancel`，不能只 free 缓冲 |
| RTP 推流线程 | 普通任务 | `get_frame` → 打包发送 → `release_frame` | 有超时等待（约 150ms），避免停产帧后永久阻塞 |
| RTSP 信令线程 | 普通任务 | `accept` / 会话控制 | deinit 时关 socket 打断阻塞，防双 close / UAF |
| CLI / 业务 | 普通任务 | start / stop 编排 | 严格启停顺序 |
| 排空线程（移植版） | 普通任务 | 长时间只开 DVP 不推流时丢弃帧，防帧池塞满 | 优先级需高于 `dvp_work_thread` |

## 技术流程

### 硬件接口与引脚

| 信号 | GPIO | 第二功能 |
|------|------|----------|
| I2C1 SCL / SDA（配置传感器） | GPIO0 / GPIO1 | `I2C1_SCL` / `I2C1_SDA`，与 RTC（BM8563）共总线 |
| MCLK / XCLK | GPIO27 | `JPEG_MCLK` |
| PCLK | GPIO29 | `JPEG_PCLK` |
| HSYNC / VSYNC | GPIO30 / GPIO31 | `JPEG_HSYNC` / `JPEG_VSYNC` |
| DATA0~7 | GPIO32~39 | `JPEG_PXDATA0~7` |

要点：

1. `CONFIG_GPIO_DEFAULT_SET_SUPPORT` 下 `bk_i2c_init` 不再改脚，GPIO0/1 必须在开机 GPIO 表中 ENABLE 第二功能，否则 detect 阶段 SCL timeout；
2. **GPIO28 是以太网 PHY 复位脚，不可挪作 DVP / I2S 使用**；
3. i602 使用 `CONFIG_DVP_CAMERA_I2C_ID=1`（SDK 默认常为 2 / 软件 I2C），移植到 demo 板时用 `SIM_I2C0`（GPIO0/1）；
4. 电源脚 `CONFIG_DVP_CTRL_POWER_GPIO_ID=255` 表示不操作独立供电 GPIO。

### 传感器时序配置（GC2145）

H264 直连在 `bk_dvp_open()` 完成默认 ppi/fps 配置后，再覆盖一组「慢灌入」时序（`dvp_h264_apply_slow_fill_timing()`），随后调用 `bk_dvp_h264_pipeline_resync()` 清脏标志并强制下一帧 IDR：

| 寄存器 | 值 | 含义 |
|--------|-----|------|
| `0xfe` | `0x00` | page 选择 |
| `0xf8` | `0x85` | PLL / PCLK 相关 |
| `0x05` / `0x06` | `0x01` / `0x80` | HB = `0x0180` |
| `0x07` / `0x08` | `0x00` / `0x18` | VB = `0x0018` |

MCLK 按格式分流（以 `dev_dvp_camera.c` 中 `fmt & IMAGE_H264` 分支为准）：

| 图像格式 | MCLK | 理由 |
|----------|------|------|
| `IMAGE_H264`（直连） | 16M | 压低 active 期灌入峰值，给编码器留喘息 |
| `IMAGE_YUV`（cap / TDM 采集） | 24M | 实测采集约 21.5fps |
| MJPEG | 16M | 沿用原路径 |

> 注意：CLI 日志里可能出现「对齐 dvp_cap：MCLK24」之类措辞，属调参残留，实际以驱动分支为准。

### 分辨率、帧率与编码吞吐约束

| 分辨率 | 每帧像素 | YUYV 数据量 | 单帧编码时间 | 编码吞吐上限 |
|--------|----------|-------------|--------------|--------------|
| 1280×720 | ~92 万 | ~1.84MB | ~230ms | JPEG **~4.3fps** |
| 640×480 | ~31 万 | ~0.61MB | ~77ms | JPEG **~13fps** |

- sensor active 期突发速率约 **13.8M 像素/秒**（720 行在约 68ms 内吐完），而 JPEG 硬件编码器消费速率约 **4M 像素/秒**，一帧积压约 1.3MB；
- H264 编码器吞吐更高（约 6.5M 像素/秒），720P 理论上限约 **7fps**（直连并达标后实测可到约 29fps，见 §4.5）；
- GC2145 驱动支持的分辨率：480×320、480×480、640×480、800×480、864×480、1280×720、1600×1200；
- 默认推荐档位为 **864×480@30 MJPEG**；`dvp_start` 移植版默认降到 **800×480** 以减轻与通话主线程同跑时的压力。

**结论性约束：不要轻易把 1280×720@30 当产品参数**。该配置下易出现 `jpeg code rate is slow` / `sensor fifo is full`，编码帧率变为 0，表现为「RTSP 有会话、无画面」——这是能力边界，不是再调一下 API 就能解决。

### 缓冲与 FIFO 约束

| 缓冲 | 位置 | 规格 | 约束 |
|------|------|------|------|
| yuv_buf 内部 FIFO | RTL 固定 | 几十 KB 量级，寄存器不暴露、不可配 | 直连 720P 必被灌爆 → 触发复位死循环 |
| H264 直连 EM（滚动缓冲） | **SRAM** | `width × 32 × 2`，720P 约 80KB | 必须 `os_sram_malloc`；`em == emr`（同一块） |
| TDM 内存池 | PSRAM | 2 个 1.8MB 槽位，乒乓 | 供 nosensor 编码读 |
| 帧缓冲 slab | PSRAM | 由 `ram_regions.csv` 划分 | MJPEG/H264 帧缓冲走 `PSRAM_MEM_SLAB_ENCODE`，未划分易申请失败 → 无流 |
| 单帧缓冲上限 | PSRAM | `CONFIG_H264_FRAME_SIZE` 由 102400 → 122400 → **153600** | 拉大缓冲以减轻 `h264 encode error` |

分区调整（`partitions/bk7258/ram_regions.csv`）：`PSRAM_MEM_SLAB_ENCODE` 由 `0x000000` 改为 **`0x07D000`**，`PSRAM_MEM_SLAB_DISPLAY` 由 `0x07D000` 改为 `0x000000`（Demo 不依赖 display slab）。

EM 分配与地址校验（脱敏后片段）：

```c
uint32_t em_bytes = (uint32_t)config->config.width * 32 * 2;
controller->encode_buffer = os_sram_malloc(em_bytes);   /* 不能用 os_malloc，否则落到 PSRAM */

yuv_mode_config.base_addr     = encode_buffer;   /* sensor / 写入侧 */
yuv_mode_config.emr_base_addr = encode_buffer;   /* 编码器读取侧，必须同一块 */
```

启动日志会打印地址区间（`SRAM` / `PSRAM?!` / `OTHER`）：若出现 `PSRAM?!`，直连基本不可用，应先查 `os_sram_malloc` 与 heap 配置。

### 编码器时钟与画质参数（`dvp_camera_h264_mode()`，DMA 配置前）

| 项 | 通流临时档（旧） | 直连达标档（新） |
|----|------------------|------------------|
| init_qp | ~45 | **30** |
| i_min_qp / i_max_qp | — | 20 / 35 |
| p_min_qp / p_max_qp | — | 20 / 32 |
| quality bits | ~80 | **180 / 70** |
| encode fps | — | 30（`bk_h264_updata_encode_fps(30)`） |
| jpeg / yuv_buf clk | 默认偏低 | **480M**（`clkdiv_jpeg=0`、`jpeg_clk_sel=1`） |

旧档帧长约 14KB、方块明显；新档目标接近 MIDDLE~HIGH。平台上 **yuv_buf 与 jpeg 同源时钟**，提时钟的目的是让编码器侧抽行速度跟上 sensor，而不是改善 JPEG 本身；移植版中也把 `PM_DEV_ID_CIF` 提到 480M。

### 帧队列与多消费者

```text
生产者（DVP 回调）: malloc（in_use=1）→ 成功 complete → ready，通知已注册消费者
                    失败 → cancel → 清 in_use 并回收（禁止只 free 缓冲）
消费者（RTP / 业务）: register_consumer(format, id) → get_frame → release_frame
                    所有相关消费者都 release 后才真正回池
```

多消费者以位图表示（`CONSUMER_DECODER` / `TRANSMISSION` / `STORAGE` / `CUSTOM_*`）；RTSP 侧使用 `CONSUMER_DECODER`。多个业务可各自注册 `CONSUMER_CUSTOM_*` 与 RTSP 并存，各自 release。

### 封装与网络（RTSP / RTP）

| 项 | 值 |
|----|-----|
| RTSP 端口 | 7070（`SERVER_RTSP_PORT`，见 `rtsp.h`） |
| RTP / RTCP | 55532 / 55533 |
| 默认格式 | MJPEG（`IMG_MJPEG`）；H264 需 open + 注册消费者 + RTSP 格式三处联动 |
| 依赖 | 强依赖以太网 IPv4 就绪；`rtsp_start` 先 `net_configure_address(&eth_ip_settings, net_get_eth_handle())` 再轮询等待 IPv4（最多 60s，i602 Demo 约 20s） |
| 拉流 | `ffplay rtsp://<设备以太网IP>:7070` 或 VLC |

`rtp_port.c` 与 IP-Cam demo 同源，以以太网 netif 为准、**不做 WiFi 回退**。RTSP 无鉴权，仅适用于内网联调。

### 启停状态机（顺序必须遵守）

```text
启动: bk_psram_frame_buffer_init() → frame_queue_v2_init_all()
    → frame_queue_v2_register_consumer(IMAGE_MJPEG, CONSUMER_DECODER)
    → dev_dvp_camera_open(864, 480, FPS30, IMAGE_MJPEG)
    → 等待以太网 IPv4 → rtsp_service_init(&cam)
停止: rtsp_service_deinit()（先断客户端与 listen，等线程退出再 free）
    → dev_dvp_camera_close()
```

顺序反了或漏一步，会出现无帧、内存泄漏、线程挂死、双 close 等问题。移植版另约定：`uvc_start` 与 `dvp_start` 互斥；`rtsp_start` 前必须先 `dvp_start` 或 `uvc_start`。

### 关键宏组合（缺一即假编译或运行半残）

```text
CONFIG_DVP_CAMERA=y          CONFIG_YUV_BUF=y      # DVP_CAMERA 依赖 YUV_BUF，未开会被 Kconfig 丢弃
CONFIG_GENERAL_DMA=y         CONFIG_JPEGENC_HW=y   # 否则链接 bk_jpeg_enc_global_soft_reset 等报 undefined reference
CONFIG_DVP_GC2145=y          CONFIG_DVP_CTRL_POWER_GPIO_ID=255
CONFIG_DVP_CAMERA_I2C_ID=1   # i602；移植版为 2（软件 I2C）
CONFIG_CAMERA_RTSP_DEMO=y    CONFIG_MEDIA=y        # 移植版媒体总开关
```

## 调试过程记录

### 720P 直连出图恒为 0 帧

| 项 | 内容 |
|----|------|
| 现象 | 1280×720 怎么调都不出图，只有降到 640×480 才出图；日志刷 `sensor fifo is full` |
| 定位 | 对比 720P / 480P 的每帧数据量与编码器消费速率；核对 yuv_buf 内部 FIFO 深度（RTL 固定、寄存器不暴露） |
| 根因 | 直连路径上 sensor 突发速率（~13.8M 像素/秒）远高于 JPEG 编码器（~4M 像素/秒），一帧积压约 1.3MB，几十毫秒内把 FIFO 灌满 → `sensor fifo is full` 中断 → 系统判定采集异常、**整套硬件复位** → 下一帧又灌满 → 复位死循环，永远出不来完整帧 |
| 修改 | 试过降 sensor 帧率、改 MCLK、调 JPEG 时钟与码率等直连参数，**全部失败**；最终改为时分复用（采集走 YUV 模式 DMA 直写内存、编码切 nosensor 模式读内存）绕开 FIFO |
| 验证 | 720P MJPEG 稳定出图 ~4fps，编码无错误，采集数据 100% 有效；~4.3fps 是 JPEG 硬件吞吐上限，属物理限制而非链路故障 |

### 时分复用方案：出图全绿

| 项 | 内容 |
|----|------|
| 现象 | 时分复用首次接真实传感器出图，但画面**全绿** |
| 定位 | 抓取内存中各槽位的 YUYV 数据，发现数据全是 0（采集阶段拿到的不是有效像素） |
| 根因 | 每次编码完切回采集时，yuv_buf 重新初始化**未配置 vsync / hsync 极性**，默认按低电平并做时序反转；GC2145 实际为高电平有效。极性反了 → 采集时序错乱 → 数据全 0 → 编码出纯绿 |
| 修改 | 切换函数中显式设置 `vsync = hsync = SYNC_HIGH_LEVEL`（与 GC2145 一致） |
| 验证 | 修复后采集数据 100% 有效，全绿现象消失 |

### 分层验证：先用纯色图把链路逐层打通

为避免「传感器问题」与「链路问题」混在一起，先用纯色图逐层验证：

| 测试模式 | 内容 | 验证目标 |
|----------|------|----------|
| `testpat` | 纯色 JPEG 直接注入推流队列 | RTSP / RTP / 网络链路 |
| `testpat_enc` | 纯色 YUV 喂 JPEG 硬件编码器（nosensor + DMA） | JPEG 编码器 720P 吞吐 |
| `testpat_h264` | 纯色 YUV 喂 H264 硬件编码器（nosensor + DMA） | H264 链路与 nosensor 可行性 |

三关通过后才接真实传感器，把「采集 → 内存 → nosensor 编码」落到真实数据上。

### H264 直连：从「灌爆即复位」到「脏帧丢弃 + 限速软恢复」

| 项 | 内容 |
|----|------|
| 现象 | 直连 H264 常见 `sensor fifo is full` → 帧率崩到 0 或个位数；`h264_err` / `enc_slow` 之后长时间没有 `FINAL_OUT`；告警一来就走 PPI 错误路径，下个 VSYNC 整模块硬复位，正在编的帧永远完不成 |
| 定位 | 在 SM0 / SM1 写满中断打时间戳做「灌入计量」（fill16）；在 `H264_LINE_DONE` / `ENC_LINE` 统计相邻 16 行编码间隔（排水诊断）；两者窗口对比找峰值不匹配 |
| 根因 | ① EM 放在 PSRAM 且按整帧（1.84MB）分配，行级实时带宽不足；② 硬复位打断在编帧，导致「编码器卡死」假象与错误→复位循环；③ fill16 与编码器 drain 的峰值不在同一窗口 |
| 修改 | ① EM 改为 SRAM `width × 32 × 2`（约 80KB）、`em == emr` 32 行滚动；② `YUV_BUF_FULL` / `H264_ERR` / `ENC_SLOW` 由 `ppi_err` 硬复位改为「标脏 + 计数」，EOF 处丢弃脏帧；③ 连续脏帧（`dirty_streak ≥ 30`）且约 40 个 VSYNC（约 2s@20fps）才做轻量 `pipeline resync`；④ 编码器时钟提到 480M、QP 收紧；⑤ MCLK 降到 16M 并写 HB / VB 压低灌入峰值 |
| 验证 | 直连 720P 达到 ~29fps，`FINAL_OUT` 持续，偶发 fifo / h264_err 不再打死整条流水线 |

新的 VSYNC 处理（脱敏伪码，`dvp_camera_vsync_negedge_handler`）：

```c
if (handle->error) {                      /* 尺寸不匹配等真错误：仍走硬复位 */
    /* hard reset */
} else if (dirty_streak >= 30) {
    s_vsync_since_resync++;
    if (s_vsync_since_resync >= 40) {     /* 约 2s@20fps */
        bk_h264_encode_disable(); bk_yuv_buf_soft_reset(); bk_h264_soft_reset();
        sequence = 0; regenerate_idr = true; s_fill_t_us = 0;
        bk_yuv_buf_start(H264_MODE); bk_h264_encode_enable();
    }
} else if (regenerate_idr) { sequence = 0; bk_h264_soft_reset(); regenerate_idr = false; }
```

EOF 处的取舍：脏帧只丢帧、**不做 soft_reset**（避免每脏帧都复位反而加剧问题），清本帧 dirty 但保留 `dirty_streak`。

### HB 标定：用 fill16 实测反推帧率

线时间经验公式（本板实测外推）：

```text
线时间 ≈ 48.5 + 0.0265 * HB      (µs)
目标 fill16 ≈ 920µs  →  HB ≈ 0x0180
```

| HB | fill16≈ | 约等于帧率 | 阶段意图 |
|----|---------|------------|----------|
| `0x0A00` | 1861µs | ~11fps | 先把 fifo 压到 0，证明 SRAM EM 通路可行 |
| `0x0500` | 1318µs | ~16fps | 中段外推 |
| **`0x0180`** | **~920µs** | **≥20fps，并向 29 靠** | 当前落点 |

调参次序：先慢灌入（大 HB / 低 MCLK）换稳定性 → 确认 `fifo=0` 且 `FINAL_OUT` 稳定 → 再按 fill16 实测收 HB 抬帧率 → **不要在 fifo 仍存在时盲目提 PCLK**。

窗口判定文案与动作：

| 条件 | 结论 | 建议 |
|------|------|------|
| min ≥ 800 且 avg ≤ 1000 | **PASS** | 落在 ≥20fps 带 |
| min < 800 | **FAST** | 加大 HB，或保持/降低 MCLK |
| avg > 1000 | **SLOW** | 减小 HB，或适度提 PCLK（需重测峰值） |

日志读法：`fill16` 无采样→SM0/SM1 ISR 未挂上；`FAST` + `fifo↑`→灌入太猛；fill16 正常但 `final=0`→编码器卡死 / 未 enable / EM 配错；`line↑` 但 `final=0`→整帧状态机卡住，等 streak resync；`final↑` 但应用无帧→EOF 后 callback / 队列问题。

### 三道门禁：把「直连跑不起来」拆成可独立回答的问题

| 门禁 | CLI | 行为 | 判定 |
|------|-----|------|------|
| 采集门禁 | `cam_test start dvp_cap [5\|10\|15\|20]` | 不启 RTSP、不启编码器；1280×720 YUYV 2 槽池；`dvp_cap_test_hook_isr()` 把 FULL / ENC_SLOW / SEN_RESL / H264_ERR 改为只计数，避免默认硬复位污染「只测采集」 | 目标 fps 附近稳定且 `fifo_full` 增量≈0；FAIL 且 fifo↑ 先调 MCLK / HB，FAIL 但 fifo=0 查池空 / 回调 / 分辨率配置 |
| 编码门禁 | `cam_test start h264_enc` | 不启 camera、不启 RTSP；纯色 YUV → H264 全速打，用 `H264_LINE_DONE` 统计 LINE16 | `win_fps ≥ 20` 且峰值相对目标 PCLK 可接受；<20fps 说明编码器吞吐本身不够，直连无解 |
| 合路径 | `cam_test start dvp_h264_direct` | `IMAGE_H264` + MCLK16 + 32 行 SRAM EM + 启 RTSP | 看 fill16、h264_drain、direct frames 与画面 |

推荐联调顺序：`dvp_cap → h264_enc → dvp_h264_direct`，任一门禁失败不要在合路径上盲改。TDM 路径（`dvp_h264`）完整保留，与直连并存于 CLI。

### 帧队列与 RTSP 生命周期问题（出一张图之后仍有一串坑）

| 现象 | 定位 / 根因 | 修改 |
|------|-------------|------|
| 逐渐无帧 | `complete` 失败时只 free 缓冲、未 `cancel`，队列节点 `in_use=1` 永久占用 | `dev_dvp_camera` 失败路径补 `frame_queue_v2_cancel` |
| RTP 线程退不出 | `get_frame` 用 `WAIT_FOREVER` 无限等 | 改为约 150ms 有限超时轮询状态 |
| UAF / 双 close / accept 挂死 | RTSP deinit 未打断阻塞，listen socket 被 close 两次，accept 失败路径漏 fd | deinit 先关 client / listen fd 等线程退出再 free；同批修掉双 close 与漏 fd |
| 客户端重连后不再收流 | 旧 RTP 线程未回收、PLAY 前残留旧帧 | 新增 `rtp_service_shutdown`（重连前先收线程）、PLAY 前 `rtp_stream_drain_discard`、RTP 读帧改 50ms 超时以便 TEARDOWN 退出、去掉线程内 2s profiler 阻塞 |
| 有会话无画面（0Kbps） | 曾用排空线程且 RTP IDLE 阶段丢弃全部 H264，PLAY 时 `frame is NULL` | 改为开 DVP 即注册 `CONSUMER_DECODER`、IDLE 不排空 H264、等首帧 `ipcam_wait_h264_ready` |

### CP 写 AP PSRAM 触发 MemFault

- **现象 / 根因**：`cif_thread` MemFault；`CP_MPU_PSRAM_ISOLATE` 下，AP 侧 PSRAM 的 image 窗口默认可只读，CP 的 `cif_free_*` 写 `need_free` 时越权触发异常。
- **修改 / 验证**：`cp/components/controller_if/cif_mem_mgmt.c` 在 cif free 前后开 / 关 MPU image 窗口，MemFault 消失；**其它「CP 写 AP」路径仍需同样排查**。

### 传感器探测失败（I2C）

- **现象 / 根因**：detect 不到 0x2145、读 ID 失败或 SCL timeout；① GPIO0/1 未在开机 GPIO 表中 ENABLE I2C1 第二功能；② 误开 `CONFIG_SIM_I2C_HW_BOARD_V3=y`（走 GPIO5/8），而 demo 板传感器 SCCB 实际接在 `SIM_I2C0`（GPIO0/1）。
- **修改**：GPIO0/1 改为 `GPIO_SECOND_FUNC_ENABLE`；`CONFIG_SIM_I2C=y` 且 `# CONFIG_SIM_I2C_HW_BOARD_V3 is not set`；板级若确有 GPIO5/8 走线，在该产品单独改回并按原理图核对。
- **备注**：GC2145 与 RTC 同挂 I2C1，并发访问尚无总线仲裁策略文档，属遗留风险。

### 以太网不通 / 无 IPv4 / 帧池塞满

| 项 | 内容 |
|----|------|
| 现象 | 开机 `phy_connect() failed`、`st … PHY: 0…31 not found`；`rtsp_start` 后 60s 无 IPv4、`RTP_PORT: eth is not ready`、RTSP 任务退出；另有「先 link up、约 20s 后 link down」 |
| 定位 | 比对引脚分配与 demo 板走线：`CONFIG_ETH_PIN_GROUP0` 的 RMII 占用 GPIO27、29、32~39，**与 DVP / JPEG 数据线重叠**；GROUP1 走 GPIO46~55，与 `usr_gpio_cfg.h` 中 LCD 引脚为时分复用 |
| 根因 | ① 引脚组与 demo 板实际走线不一致 → PHY 连接失败、无 IPv4；② GROUP1 与 LCD 争用，VoIP / UI 拉起后链路掉线、DHCP 拿不到地址 |
| 修改 | 与 IP-Cam demo 对齐为 `CONFIG_ETH_PIN_GROUP1=y`、关闭 GROUP0，PHY 仅保留 YT8522；`rtsp_start` 前先 `net_configure_address(...)` 再轮询等 IPv4，打印 ETH 快照横幅与每 10s 进度（含 `link_up`） |
| 另一现象 | 只开 DVP 未及时 `rtsp_start` 时，RTP 处于 IDLE 不取帧 → 帧池塞满 → `sensor fifo is full` |
| 对应修改 | 增加 `rtp_stream_drain_discard` 与排空线程（H264 `CUSTOM_2`、YUV `CUSTOM_3`），线程需先于 `dev_dvp_camera_open` 启动且优先级高于 `dvp_work_thread`；`CONFIG_H264_FRAME_SIZE` 102400 → 122400 → 153600 |
| 观察补充 | 日志中 `yuv_buf: sensor fifo is full` / `jpeg code rate is slow` 刷屏会淹没 `rtsp:` 行，联调时每条 CLI 后应回车，可先 `dvp_stop` 再降分辨率启动 |

### 硬解 + LCD 渲染：分辨率对内存与稳定性的影响

链路：`dvp（W×H）→ MJPEG → 硬解 → YUV422 → lv_dma2d_yuv_pfc_to_rgb565_inset → RGB565 → 渲染`，屏为 1024×600。测量方法是在线程内周期性打印 RTOS 堆统计与 PSRAM 布局：

```c
/* RTOS 堆统计：与 CLI memfree 同源；min_free 越低说明历史上堆越紧张 */
size_t ht = rtos_get_total_heap_size();
size_t hf = rtos_get_free_heap_size();
size_t hm = rtos_get_minimum_free_heap_size();
LOGI("heap %s: total=%u free=%u min_free=%u used=%u peak_used~=%u\r\n",
     where, (unsigned)ht, (unsigned)hf, (unsigned)hm,
     (unsigned)(ht > hf ? ht - hf : 0U), (unsigned)(ht > hm ? ht - hm : 0U));
```

时间线：基线 473ms（LVGL 就绪 + RGB 缓冲分配后）→ 运行时首次 3837ms（硬解 + LCD 启动后约 3.4s）→ 稳态 486s（采样 158 次）。

| 分辨率 | SRAM 解码增量 / 剩余 | PSRAM 解码增量（ENCODE + DISPLAY） | 现象 | 解码成功率 | 丢帧率 |
|--------|----------------------|------------------------------------|------|-----------|--------|
| 1280×720 | +82.63KB / 133KB | +2.15MB（+0.39 / +1.76） | 花屏闪烁，暂未崩溃 | 97.5% | 73.3% |
| 800×480 | +69.38KB / 148KB | +1.12MB（+0.39 / +0.73） | 屏幕闪黑条，未崩溃 | 82.4% | 41.2% |
| 640×480 | +64.34KB / 153KB | +0.59MB（+0.39 / +0.59） | 闪黑条，约 1 分钟后崩溃白屏 | 87.0% | 12.4% |
| 480×480 | +58.83KB / 158KB | +0.83MB（+0.39 / +0.44） | 闪黑条，约 1 分钟后崩溃白屏 | 90.7% | 23.9% |

同时注意两个需要留意的数据特征：分辨率越高，SRAM / PSRAM 解码增量单调上升，但**最高分辨率反而解码成功率最高、丢帧率最严重**（花屏源于丢帧而非解码失败）；低分辨率则表现为解码错误显著增多并最终崩溃白屏。另一轮独立统计给出的数字与此不同（SRAM 解码增加 +73KB、剩余 180KB；PSRAM 增加 2.83MB、剩余 4.3M），两轮统计口径不同，详见附录。

常用观测点：采集侧每 3s 打印 fps、帧间隔 min / avg / max、`fifo/frame`、`pool_empty`；编码侧看 `win_fps`、`LINE16_us` 的 max 与 `active16@PCLK`（72 / 48 / 36 / 24M 两套口径）对比、`BENCH PASS/FAIL`；应用侧约每 20 帧打印 `h264 direct frames= seq= len=`，`len` 长期仅 ~14KB 说明画质仍偏软；告警按 50 / 20 次限频。

## 结论、注意事项与遗留问题

### 结论

1. 出图链路的首要约束是 **sensor 突发写入速率 vs 编码器匀速消费速率**：直连小 FIFO 在 720P 下无法承受，480P 因每帧数据量仅 1/3 而勉强可用。
2. 绕开 FIFO 有两条成熟路线：**时分复用 + nosensor 编码**（软件控节奏，720P MJPEG ~4fps）与 **SRAM 32 行滚动 EM 直连**（~29fps，依赖 fill16 / LINE16 峰值匹配）。
3. 高帧率不是把 fps 寄存器写大，而是同时满足：SRAM 32 行滚动 EM + 灌入（fill16）贴近排水（LINE16）+ 告警不硬复位 + 卡死才轻量 resync + 时钟 / QP 够用。
4. 能出图 ≠ 稳定：帧队列 cancel、RTP 超时、RTSP deinit、排空策略这些生命周期问题会在出图之后才暴露。

### 注意事项（落地清单）

1. **分辨率与内存**：优先 864×480@30 MJPEG，1280×720@30 属能力边界之外（会退化为「有会话无画面」）；EM 必须 `os_sram_malloc(width×32×2)` 且 `em == emr`（拆双口并开 `bps_pingpong` 会没有 `FINAL_OUT`），PSRAM 按 `ram_regions.csv` 划出 ENCODE slab。
2. **回调与队列**：`malloc` / `complete` 路径禁止阻塞、长耗时与日志洪泛；失败必须 `cancel`。
3. **宏组合**：`DVP_CAMERA` + `YUV_BUF` + `GENERAL_DMA` + `JPEGENC_HW` + PSRAM + `CAMERA_RTSP_DEMO` 缺一不可；改完 `config` 建议 fullclean 或删构建目录下 `sdkconfig` 后重配全编。
4. **引脚**：GPIO28 留给 PHY 复位；RMII 引脚组必须与板级实际走线一致，并注意与 LCD 的时分复用冲突。
5. **启动顺序与安全**：先 `bk_psram_frame_buffer_init` / 队列 / 注册消费者 / 开 DVP / 等 IPv4，最后启 RTSP；停止时先 RTSP 再关 DVP。RTSP 无鉴权，仅限内网联调，勿暴露公网。

### 遗留问题

1. 720P MJPEG ~4fps 是 JPEG 编码器物理上限，提速需改用 H264 或降分辨率；`em_base` 能否直接指向采集槽位以省掉每帧 1.8MB 中转拷贝、`yuv_buf` 采集与 nosensor 编码能否同时使能（真流水线），均待验证。
2. `dev_dvp_camera.c` 中残留旧时序注释（`0xf8=0x86 HB=0x0A00 VB=0x0028`）与 `bk_dvp.c` 实际写入不一致，需清理；`recover_pending` 字段已加入结构体但未充分使用，当前逻辑依赖 `dirty_streak` + VSYNC 计数。
3. 时序表按 GC2145 语义写死、MCLK16 + HB 为当前板级经验值，换 sensor / 模组 / PCB 需重做 HB / PCLK 标定并重跑 fill16；脏帧丢弃会造成瞬时帧率抖动，产品侧若要更平滑可考虑「脏帧后强制 IDR」。
4. 未做量产级 soak、高低温、多客户端、与通话并发压测；传感器掉线 / I2C NACK / DMA 异常的自动恢复未产品化；移植版未迁移 WiFi 管理（`rtp_port.c` 无 WiFi 回退）；i602k 配置未跟进。
5. 硬解 + LCD 渲染链路的闪黑条 / 花屏 / 白屏崩溃尚无明确根因与修复结论（仅观测数据）。

## 附：信息不足的源文件

| 源文件 | 可用信息 | 不足 / 待补 |
|--------|----------|-------------|
| `DVP_720P出图分析.md` | 通路对比、FIFO 约束、TDM 方案与 720P 出图结论 | 只有吞吐量级估算，缺实测帧率曲线与长稳数据 |
| `DVP_CAMERA_RTSP使用说明.md` | 工作模式、回调 / 任务分工、启停状态机、隐患清单 | 隐患多为定性判断，未附压测数据 |
| `dvp_h264_direct_29fps.md` | EM 改造、时序标定、错误恢复状态机、门禁设计 | `recover_pending` 未启用；注释与实际时序不一致；换板标定缺失 |
| `IP_CAM_VIDEO_PORT_QEMU_VOIP.md` | 移植、Kconfig / GPIO / 以太网 / RTSP 变更记录 | 仅现象与改动记录，缺根因分析与量化验证；日志文件为个人目录、已脱敏 |
| `i602_camera_test.md` | 提交范围、配置、CLI / HQA 步骤、未覆盖项 | 未含 720P 与 H264 推流的实测结论 |
| `硬解码部分.txt` | 硬解 + LCD 渲染链路的堆统计方法、四种分辨率的内存与成功率数据 | 为原始笔记：多轮统计口径不一致（SRAM 解码增量 +73KB 与 +82.63KB、PSRAM 剩余 4.3M 与 2.36M 并存），且缺少根因、修改与最终验证结论；部分片段（`ENCODE 峰值 400.3KB / 稳态 101.37KB`、`717.63KB / 119.61KB`）无上下文，无法判定对应分辨率 |
