+++
title = '屏幕-02 屏幕适配与 LVGL 调试'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 2
+++

MB12-V2 主屏是 ST7567，128×48、正显、4 线 SPI，背光落在 GPIO24。产品原先走「无屏」路径，Post、AP、ATE 都不真正刷屏。适配横跨三个仓，还牵出告警灯测项与硬解码显示通路两条支线。下面把整条适配链路和踩过的坑记一遍。

> 整理自多份适配说明、提交记录与调试笔记，仅覆盖**技术流程**与**调试过程**（现象 → 定位手段 → 根因 → 修改 → 验证结论）。源文档与代码注释仅作参考，冲突时以仓库源码为准；文中不含原始品牌词、人名与内网地址。

| 来源 | 主题 | 关联提交 |
|------|------|----------|
| 适配原理说明 / 提交详解 | MB12-V2 ST7567 屏幕适配（三仓） | `074461b8398…`、`63ad5722980…`、`65c216140c9…` |
| 提交详解 | MB12-V2 屏幕调试（smp 仓 24 文件） | `021f596dc21171b178e7e3a8011a26f1e2569cc4` |
| 规格对齐笔记 | 规格书 / 原理图 / 代码三方对齐 | — |
| 适配说明 | MB12-V2 LED 告警灯 ATE 测项 | `8ed81c016bd…`、`18b2f7b7498…` |
| 调试笔记 | LCD UI 水平翻转、硬解码显示通路 | — |

## 概述

1. **MB12-V2 单色小屏落地**：产品原先走「无屏」路径（`X_SCREEN_DUMMY` / `__NO_SCREEN_SUPPORT__` / 无屏预选 `STANDALONE_I12`），Post、AP、ATE 都不真正刷屏。适配后复用 V50 的 ST567 mono 刷屏路径，抽象出 `MONO_COG` 宏族（ST567 | ST7567），再按面板差异修正分辨率、列地址字节序、亮暗极性、显示模式与背光脚。
2. **告警/状态灯与 ATE 测项**：告警灯不全是普通 GPIO，部分走 PWM，且开启加热配置时 LED 测项要与加热脚同进同出。
3. **硬解码显示通路的性能与内存验证**：`DVP → MJPEG 硬解 → YUV422 → RGB565 硬件转换 → RGB 渲染` 通路上，不同分辨率的内存增量、解码错误率与丢帧率差异明显。

三者共同点：**屏幕能否显示，取决于「硬件脚位 → 驱动参数 → 上层宏」三者一致**，任一处错位会表现为花屏、反色、黑屏或「有驱动无 UI」。

## 硬件与软件结构

### 面板规格（MB12-V2 主屏）

| 项 | 规格 |
|----|------|
| 模组型号 | `TS-GG128048014W`（客户料号 GLC.0028-1） |
| 驱动 IC / 分辨率 | **ST7567** / **128 × 48**（SEG×COM） |
| 面板类型 | STN 灰白、半透、**正显** |
| Duty / Bias / 视角 | 1/49 / 1/8 / 6:00 |
| 接口 | **4 线 SPI**（SCLK / SDA / RS / CS / RES） |
| 供电 | VDD typ 3.0V；升压 VLCD/VOP typ 8.0V |
| 结构 / 可视区 / AA | COG + FPC + 白光背光；76.00×29.30 mm / 66.54×24.94 mm |

规格书正文曾出现「并行」字样，但 Features 与管脚定义均为串口（SDA/SCLK/RS/RES/CS），**以管脚与 Features 为准**。

### 板端引脚（模组 ↔ 主控）

| 模组信号 | 板级网名 | 主控 GPIO | 代码侧 |
|----------|----------|-----------|--------|
| SCLK / SDA | `LCD_CLK` / `LCD_SDI` | GPIO14 / GPIO16 | SPI0 SCK / MOSI |
| /CS | `LCD_CS` | GPIO15 | SPI CS |
| RS(DC) | `LCD_RS` | GPIO17 | `POST_LCD_DC_GPIO` |
| /RES | `LCD_RESET` | GPIO23 | `POST_LCD_RESET_GPIO` |
| 背光控 | `LEDC` ↔ `PWMG0_PWM4_LCD` | **GPIO24**（PWM0_4） | 现用 **GPIO 恒高**，硬件仍可走 PWM4 |
| 加热 | — | **GPIO22**（低有效） | **禁止当背光** |

块图标示为 `LCD 128×48 / SPI0`，与 Post/AP 配置（SPI0 + DC=17 + RST=23 + BL=24）一致。

### 软件仓库与宏族

适配横跨三仓，**三仓宏必须一致**，否则会出现「有驱动无 UI」或「有 UI 无设备」：

| 仓 | 角色 | 关键宏/常量 |
|----|------|-------------|
| `bk_avdk_smp` | 驱动与板级底座（Post / AP / ATE 配置） | `CONFIG_LCD_SPI_ST7567`、`CONFIG_LCD_SPI_MONO_COG` |
| `xapp` | 业务编译宏与 stub | `__MONO_LCD_SUPPORT__`、`__SPI_PANNEL_ST7567__` |
| `xGui` | 图形后端、字体、产品常量 | `MONO_COG`、`WIN_MAX`、`xui_bkScrn_mono_draw.c` |

Kconfig 中的族宏设计：

```text
LCD_SPI_ST7567   (bool, 128x48)
LCD_SPI_ST567    (bool, 132x64，保留)
LCD_SPI_MONO_COG (bool, 无菜单项)  default y if LCD_SPI_ST567 || LCD_SPI_ST7567
```

约束：**同一产品只应开启一块 SPI 面板**。上层大量 `#if CONFIG_LCD_SPI_ST567` 收敛为 `#if CONFIG_LCD_SPI_MONO_COG`，具体面板差异再用型号细分。

### 设备注册链

```text
lcd_spi_st7567.c → const lcd_device_t lcd_device_st7567
    id = LCD_DEVICE_ST7567；几何 128x48；frame_len = 128*48*2（上层仍送 RGB565，再压 1bpp）
lcd_types.h / lcd_panel_devices.h / lcd_panel_devices.c → 枚举、extern、设备表登记
spi/Kconfig + spi/config.cmake → 宏开启时编入 lcd_spi_st7567.c
```

驱动侧统一判定（供 baud、skip init、跳过彩屏 window set、flush 分支共用）：

```c
static inline int lcd_spi_is_mono_cog(lcd_device_id_t id)
{
    return id == LCD_DEVICE_ST567 || id == LCD_DEVICE_ST7567;
}
```

## 技术流程

### SPI / GPIO 与背光

- Mono COG 走「软件组 page + SPI 推线」路径，**不支持 QSPI mapping 模式**（该模式下函数直接报错返回）。因此关闭 `CONFIG_LCD_QSPI`、`CONFIG_LCD_SPI_REFRESH_WITH_QSPI`、`CONFIG_LCD_SPI_REFRESH_WITH_QSPI_MAPPING_MODE`，改为纯 `CONFIG_LCD_SPI`；SPI 约 **8 MHz**、Mode0。
- AP 侧 `usr_gpio_cfg.h` 将 GPIO14–17、23 设为 `INIT_DISABLE` 交给 display 接管（对齐 V50 的 SPI handoff，避免启动早期抢脚）；GPIO24 配置为输出 + 上拉，作背光。
- **背光有两套逻辑并存**：`scrn_pwm_backlight.c` 的 ST7567 路径走 GPIO24 高低电平，即「**非 0 即亮**」的开关亮度、无细分级，其它产品仍走 PWM(GPIO22/PWM2)；ATE 路径用 `GPIO_24`，PWM 档位用 **PWM4**；Post 侧合并为 `post_lcd_backlight_apply(on)`。

### 初始化时序

面板 init 表（`lcd_spi_st7567.c`）：`E2` 软复位 → `AE` 关显 → `EE` 退出 RMW → `A2` Bias → `A0` SEG 正常 → `C0` COM 正常 → `A6` **正显** → `24` 电阻比 → `81` + `18` 对比度 → `2F` 电源全开 → `F8` + `01` Booster ratio → `40` 起始行 0 → `A4` 正常显示 → `AF` 开显。

关键点：厂商参考驱动 `scrn_MonoScrn_drv` 中每行都是**一次 cmd-only 写，没有 DC 高的 data phase**；若把对比度写成「`0x81` + 数据 `0x18`」打包，会与模组实际时序不符。

启动时序与 handoff：

```text
[Post] post_lcd_drv_init → SPI + init_cmd（含 A6 / AF）→ 不发 A7 → 背光先关
       post_show_logo / post_text → RGB565(native) → mono_cog_frame_display → SPI
       post_lcd_backlight_on (GPIO24 HIGH)
[AP，CONFIG_LCD_SKIP_HW_RESET=y]
       bk_lcd_spi_init(ST7567) → 正常：跳过 init_cmd，保留 Post 的 GRAM（开机图不闪黑重刷）
                               → OTA 异常标志置位：仍跑 init
       XUi mono_draw / ATE display_init → prepare_mono_gpio（ST7567 不发 A7）
                                        → 全帧 RGB565 → 二值化 → SPI
```

### 坐标系与翻转

单帧 RGB565 → 1bpp → SPI 的核心算法（`lcd_spi_driver.c`，由 `lcd_spi_st567_frame_display` 泛化为 `lcd_spi_mono_cog_frame_display`）：

```text
for page = 0 .. (height/8 - 1):
    for x = 0 .. width-1:
        bbyte = 0
        for bit = 0 .. 7:                # 竖直 8 像素
            pix   = fb[(y_base+bit)*w + x]
            light = rgb565_亮度判定(pix)
            if light_is_zero:  if !light: bbyte |= (1<<bit)   # ST7567：暗才置位
            else:              if  light: bbyte |= (1<<bit)   # ST567
        line[x] = bbyte
    send_cmd(0xB0 | page)
    if col_lsb_first:  send_cmd(0x00 | (col & 0x0F)); send_cmd(0x10 | (col >> 4))  # ST7567
    else:              send_cmd(0x10 | (col >> 4));   send_cmd(0x00 | (col & 0x0F)) # ST567
    send_data(line, width)
```

`bk_lcd_spi_init()` 按设备 id 写死三个参数：

| 字段 | ST7567 | ST567（else 分支） |
|------|--------|-------------------|
| `mono_col_lsb_first` / `mono_light_is_zero` | 1 / 1 | 0 / 0 |
| `mono_col_start` | 0 | 0 |

**列序或极性任一反向 → 花屏 / 整屏反色**，这是本适配最需要板测确认的点。

Post 侧坐标与翻转：

- `post_text_show.c`：几何、旋转、`log_to_phys` 坐标映射门控由 `ST567` 改为 `MONO_COG`；128×48 同样**横屏、不旋转、`FONT_SCALE=1`**（8×16 字），注释由 132/64 同步为 128/48。
- `post_logo_show.c`：mono 路径 JPG 解码后**不做 BGR / 字节交换**（与 text 及 driver 吃 native RGB565 一致）；尺寸不等于 128×48 时先白底填充、再**最近邻缩放**到面板后贴图。

Android 平台的水平翻转走系统属性而非驱动参数：

```text
getprop persist.vendor.display.flip_180   /  ro.sf.display.primary_orientation
setprop persist.vendor.display.flip_180 true   → 重启生效；wm size 确认物理分辨率 1024x600
```

### UI 布局与字体

- 产品常量 `tools/constant/mb12-v2_product_constant.txt`：`WIN_MAX` **480×320 → 128×48**，补齐 `PIC_STRETCH_VALUE_OFF`、`XUI_TITLE_LINE_Y`、列表 ratio、云输入法几何等宏。
- `productprop.txt`：`sys.screen.resolution.ratio=128*48`，供业务/网页/配置读取。
- `mb12-v2_extra.mk`：删除 `X_SCREEN_DUMMY`，开启 `X_FROGFS_PIC_SUPPORT`、`XUI_FROGFS_ICON_1TO1`（小屏图标按 1:1，避免二次缩放发糊），关闭 `X_NO_FONT_MODULE`。
- 字体门控：`xui_lvgl_font.c`（小字号字体、测宽）由 `CONFIG_LCD_SPI_ST567` 改为 `CONFIG_LCD_SPI_MONO_COG`；`screen_font_stub.c` 字宽测量门控同步，保证 stub 与真实现声明一致。
- AP 侧打开 `LVGL_VOIP` + 字体、`MEDIA_OSD`、`APP_DISPLAY_DRAW(_SOFTWARE)`，主屏走 **bkScrn mono_draw**（`X_LVGL_MONO_MAIN_SCRN=0`），而非另一套纯 LVGL 主屏。

### 告警灯 xGui 实现

分工：**xGui 登记灯脚，smp 解析并驱动**，两仓必须一起合入。

```text
xGui tools/gpio_conf/mb12-v2/gpio.conf  → 打包到 /etc/gpio.conf
smp bk_ate_led.c
  load_targets_from_led_conf()  → GPIO / dual / HC595
  load_targets_from_gpio_conf() → OUTPUT_GPIO* | OUTPUT_PWM*
  ate_apply_all / 闪烁 → is_pwm ? ate_pwm_apply(start/stop) : (is_dreg ? HC595 : GPIO/dual)
  (+ CONFIG_BK_ATE_HEAT → led_heat_on/off)
```

xGui 侧新增的 4 行灯脚登记与语义：

```text
OUTPUT_GPIO3:0,55   # 状态/告警输出
OUTPUT_GPIO4:0,19   # 同上
OUTPUT_GPIO5:0,26   # 对应 GPIO26 / LED5_R
OUTPUT_PWM1:18,0,100   # GPIO18 / PWM ch0 / 100%，需 CONFIG_PWM
```

格式约定：GPIO 为 `NAME:dir,pin`，PWM 为 `NAME:gpio,chan,duty%`；`OUTPUT_GPIO` 解析时**第二段才是脚号**。

smp 侧 PWM 生命周期：首次点亮走 `unmap → bk_pwm_init(period=1000) → pwm_ready → start`；熄灭只 `bk_pwm_stop`（不每次 deinit）；teardown 执行 `stop + deinit` 并将脚拉低；未开 `CONFIG_PWM` 时解析到 PWM 行仅告警并跳过。

加热联动挂在联机 `test_led start` 与单机 steady-on 上，测项 teardown 时关闭加热：

```c
#if CONFIG_BK_ATE_HEAT
  led_heat_on()  → bk_ate_heat_test_start(0, NULL);
  led_heat_off() → bk_ate_heat_test_stop();
#endif
```

板级侧 AP/Post `usr_gpio_cfg.h` 将 GPIO26 由 `GPIO_IO_DISABLE` 改为 `GPIO_OUTPUT_ENABLE`（LED5_R，高亮低灭）。

### 硬解码显示通路

通路结构：`DVP（如 1280×720）→ MJPEG 硬解 → YUV422 → lv_dma2d_yuv_pfc_to_rgb565_inset（硬件色彩转换）→ RGB565 →（可选裁剪）→ 渲染`。

内存统计手段：在线程内插入堆统计与 PSRAM 布局打印，与 CLI `memfree` 同源。

```c
/* RTOS 堆统计：min_free 越低说明历史上堆越紧张；peak_used ≈ total - min_free */
static void demo_log_heap(const char *where)
{
	size_t ht = rtos_get_total_heap_size();
	size_t hf = rtos_get_free_heap_size();
	size_t hm = rtos_get_minimum_free_heap_size();
	LOGI("heap %s: SRAM total=%u free=%u min_free=%u used=%u peak_used~=%u (bytes)\r\n", where,
	     (unsigned)ht, (unsigned)hf, (unsigned)hm,
	     (unsigned)(ht > hf ? ht - hf : 0U), (unsigned)(ht > hm ? ht - hm : 0U));
#if CONFIG_PSRAM
	bk_psram_memory_layout_log(TAG, where);
#endif
}
```

采集分三阶段：基线（LVGL 就绪 + RGB 缓冲区分配后）→ 运行时第一次（硬解 + LCD 启动后）→ 稳态（长时采样）。

## 调试过程记录

### 单色 COG 列地址字节序与亮暗极性

- **现象（设计约束/风险项）**：同一套「按 page 写」协议下，若沿用 ST567 的列命令顺序或亮暗语义，屏幕会**花屏或整屏反色**。
- **定位手段**：对照两块面板规格与厂商参考驱动，逐字段核对 `mono_col_lsb_first` / `mono_light_is_zero` / `mono_col_start`；用全屏、棋盘格最小测试图区分「位置错」与「颜色反」。
- **根因**：两块屏虽同属 mono COG，但**列地址命令字节序相反**（ST7567 为 `0x00` 在前、ST567 为 `0x10` 在前），且**亮像素编码相反**（ST7567 亮=不置位，ST567 亮=置位）。
- **修改**：泛化为 `mono_cog_frame_display`，由 `bk_lcd_spi_init()` 按设备 id 填参数（ST7567：`col_lsb_first=1`、`light_is_zero=1`；ST567：全 0）。
- **验证结论**：两屏共用一套刷屏算法，避免复制整份 flush 造成后续修 bug 分叉；**列序/极性须由板测确认**。

| 维度 | ST567 | ST7567 |
|------|-------|--------|
| 分辨率 | 132×64 | 128×48 |
| 列地址命令序 | MSB 命令在前 | **LSB 命令在前** |
| 亮像素编码 | 亮 → 置位 | **亮 → 不置位**（`light_is_zero`） |
| 显示模式 / 清屏 | init 后常发 **A7** / 常黑底 | **A6，不发 A7** / Post 填 **0xFF 白** |
| 背光 | GPIO22 / PWM2 | **GPIO24 / PWM4** |
| partial / QSPI mapping | 不支持 / 不支持 | 不支持 / 不支持 |

### A6 / A7 与清屏极性一致性

- **现象（设计约束）**：若 ST7567 误发 A7 会整屏反色；清屏填充极性若与驱动 `light_is_zero` 不一致，会闪黑。
- **定位手段**：以「RAM bit=1 对应像素点亮（对 ST7567 表现为黑点）」为约定，核对 init 表末端的 `A6`/`AF`、Post 清屏 `memset(..., 0xFF)` 与 `light_is_zero` 三者是否自洽。
- **根因**：ST567 在 Post/ATE 中会在 init 后再发 A7，用反显对齐「白底黑字」的 RGB565 语义；ST7567 厂商 init 表已含 A6，参考驱动按正显写像素。
- **修改**：整条链路统一「**仅 ST567 发 A7，ST7567 不发 A7**」；Post 清屏填 `0xFF`（白底，配合 A6 + `light_is_zero`）。
- **验证结论**：显示模式在 Post → handoff → AP/XUi → ATE 全链路一致，避免中途某环把极性翻回去。

### Post → AP handoff（`SKIP_HW_RESET`）

- **现象（风险项）**：AP 开启 `CONFIG_LCD_SKIP_HW_RESET=y` 后正常路径跳过面板 init 以保留 Post 已写入的 GRAM；若冷启未跑 Post LCD 或 handoff 假设不成立，AP 可能黑屏/花屏。
- **定位手段**：检查 `lcd_spi_driver.c` 中 skip init 的判定条件（依赖 OTA 异常标志），分别构造「正常启动」与「异常 OTA」两条路径观测。
- **根因**：skip init 是体验优化（开机图不闪黑重刷），代价是**初始化责任转移给 Post**。
- **修改**：保留 mono COG 设备在 OTA 异常路径下仍执行 init 的逻辑；配合 `__PANNEL_INIT_OFF_BL__` 等宏使面板初始化时关背光等行为与 handoff 策略对齐。
- **验证结论**：需板测覆盖「冷启」与「异常 OTA 后启动」，确认 AP 仍能正常 init。

### Post Logo 的 mono 路径

- **现象（设计约束）**：mono flush 直接消费 native RGB565，而开机 JPG 尺寸通常大于 128×48；若沿用彩屏那套 BGR/字节交换，颜色会错。
- **定位手段**：对比 `post_logo_show.c` 与 `post_text_show.c` 的格式约定，确认与 driver 输入一致。
- **根因**：彩屏与 mono 后端对 FB 的字节序假设不同。
- **修改**：MONO_COG 下解码后不做 BGR/字节交换；尺寸不符时白底填充 + 最近邻缩放；新增产品 Logo 资源；`post_lcd_drv.h` 显式写出 ST7567 几何宏（`WIDTH/HEIGHT/FRAME_SIZE/BL_GPIO=24`），避免各处写死 132×64。
- **验证结论**：方向、黑白、缩放锯齿需板测确认可接受；最近邻锯齿明显，对比度不适配二值化时会糊成一团。

### QSPI mapping 与 mono 不兼容

- **现象（设计约束）**：`CONFIG_LCD_SPI_REFRESH_WITH_QSPI_MAPPING_MODE` 下 mono 刷屏函数直接返回错误。
- **根因**：mono 走软件组 page + SPI 推线，与 mapping 模式的硬件刷新路径不兼容。
- **修改与验证**：产品配置关闭 QSPI 三项、改纯 `CONFIG_LCD_SPI`，驱动内在 mono 分支显式拒绝 QSPI mapping；确认 mono 亦**不支持 partial 刷新**，只能整帧 flush，动画较多时 SPI 负载偏高。

### 背光脚与加热脚混淆

- **现象（安全风险）**：任何「默认 GPIO22 作背光」的拷贝到 MB12-V2 都会**点亮加热器**。
- **定位手段**：核对原理图网名（背光 `LEDC` ↔ `PWMG0_PWM4_LCD` = GPIO24；加热为独立低有效脚）。
- **根因**：既有产品的默认背光脚是 GPIO22，直接复用会出硬伤；加热脚与背光脚编号相邻，易笔误。
- **修改**：`bk_ate_hw_version.h` 的 MB12 GPIO 表新增 `LCD_BACKLIGHT_GPIO = 24`；`scrn_pwm_backlight.c` 的 ST7567 分支走 GPIO24；ATE 用 GPIO24 / PWM4；Post 侧 GPIO24 改输出使能。
- **验证结论**：需确认亮屏全程加热脚 GPIO22 不受背光逻辑影响；两套背光路径（ATE PWM 档位 vs xapp stub「非 0 即亮」）在测项切换时需保持一致。

### ATE 侧 GPIO13 LDO 投票

- **现象（待确认项）**：ATE 显示路径仍投票 `GPIO_13` 作为 LCD LDO。
- **定位手段**：对照 MB12-V2 的 GPIO 功能分配（P13 为 HID/HW_ID ADC）。
- **根因**：该投票沿用了其它产品的 LDO 脚位。
- **修改与验证**：本次未改动该投票；**需硬件确认是否真有 LCD LDO**，误拉可能影响 HW_ID，列为板测重点。

### LED 告警灯测项

- **现象（设计约束）**：只有 xGui 的 `gpio.conf` 或只有 smp 驱动都不完整——缺 conf 时目标列表不全，缺 smp 时即使有 conf 也不会闪 PWM。
- **定位手段**：烧录后检查设备内 `/etc/gpio.conf` 是否含 `OUTPUT_GPIO3..5`、`OUTPUT_PWM1`；观察 `test_led` 日志是否出现对应目标与 `OUTPUT_PWM1 pin=18 chan=0 duty=100`。
- **根因**：告警灯并非全是普通 GPIO，部分走 PWM；且 `CONFIG_BK_ATE_HEAT` 时需与加热脚联动。
- **修改**：xGui 登记 4 条灯脚；smp 侧 `bk_ate_led.c` 增加 PWM 目标解析、apply/teardown 与加热联动，AP/Post `usr_gpio_cfg.h` 开启 GPIO26 输出。
- **验证结论**：PWM 闪烁无反复 init 失败；GPIO26 / PWM18 极性正确；`CONFIG_BK_ATE_HEAT=y` 时 LED 测项与加热脚同进同出。

### 硬解码分辨率、内存与丢帧

- **现象**：同一硬解渲染通路换不同分辨率后，出现花屏闪烁、屏幕闪黑条、约 1 分钟后崩溃变白屏等不同表现，内存增量差异也较大。
- **定位手段**：在解码/渲染线程插入堆统计与 PSRAM 布局打印，按「基线 → 运行时首次 → 稳态」三阶段采样，并统计解码错误率与丢帧率。
- **根因（观测结论）**：内存增量与分辨率正相关；部分分辨率下**解码错误率极高**导致系统不稳定，另一些分辨率则**解码成功率尚可但丢帧严重**造成花屏。
- **修改**：侧重点在**采集与量化**，以数据驱动选择可用分辨率。
- **验证结论**（实测数据）：

| 分辨率 | SRAM 解码增量 | SRAM 剩余 | PSRAM 解码增量 | 现象 | 解码错误 | 成功率 | 丢帧率 |
|--------|---------------|-----------|----------------|------|----------|--------|--------|
| 1280×720 | +82.63 KB | 133 KB | +2.15 MB | 花屏闪烁，暂未崩溃 | 49 次（16.33/s） | 97.5% | **73.3%** |
| 800×480 | +69.38 KB | 148 KB | +1.12 MB | 屏幕闪黑条，未崩溃 | **432 次（144/s）** | **82.4%** | 41.2% |
| 640×480 | +64.34 KB | 153 KB | +0.59 MB | 闪黑条，约 1 分钟崩溃白屏 | 99 次（33/s） | 87.0% | 12.4% |
| 480×480 | +58.83 KB | 158 KB | +0.83 MB | 闪黑条，约 1 分钟崩溃白屏 | 179 次（59.67/s） | 90.7% | 23.9% |

720P 长时采样（SRAM 总容量 279.07 KB，PSRAM 总容量 16.00 MB）：基线（LVGL 就绪 + RGB 缓冲分配后）61.49 KB / 22.0%，用时 473 ms；运行时第一次（硬解 + LCD 启动后约 3.4 s）144.12 KB / 51.6%，用时 3837 ms；稳态（486 s ≈ 8.1 分钟，采样 158 次）144.26 KB / 51.7%，剩余 133.07 KB，**全程波动仅 0.88 KB**，峰值增量 +84.16 KB（+136.9%）。

PSRAM 侧：`AP malloc heap` 1.50 MB 无变化；`ENCODE pool` +0.39 MB（总容量 1.37 MB）；`DISPLAY pool` +1.76 MB（总容量 9.00 MB）；Slabs 合计 +2.15 MB（+36.7%）。

摄像头（GC2145）侧据驱动代码支持的分辨率为：480×320、480×480、640×480、800×480、864×480、1280×720、1600×1200。

### Android 平台 LCD 水平翻转

- **现象**：为屏幕 UI 增加水平翻转后，编译出的镜像启动成功但**立即崩溃**——开机动画正常显示后黑屏。
- **定位手段**：观察启动阶段日志，定位到系统核心服务 `zygote` 反复崩溃并被强制终止（收到 signal 9）。`zygote` 是应用进程母体，其崩溃导致框架（System UI / Launcher 等）无法启动，屏幕因此黑屏。
- **根因**：镜像是在**缺少部分依赖**的情况下编出的（切换分支后编译，依赖的修改未完全带上）。
- **修改**：先用属性查看/开启翻转（`persist.vendor.display.flip_180`、`ro.sf.display.primary_orientation`，`wm size` 确认 1024×600）；单独编译 bootimage 并**刷入空的 vbmeta**（否则需重新签名）；单独编译报错时先确认报错文件是否属于刚挑入的仓库——实践中报错发生在 `~/work/repo/px30/frameworks/opt/net/ethernet/...`，该修改实为早已合并的旧改动，**切换该路径分支后编译通过**；最终改用脚本编译（`./tobuild.sh <产品> <变体> all`），前后配合 `make update-api -j8`、kernel `distclean + x7a_defconfig`、u-boot `clean + ./make.sh` 等步骤。
- **验证结论**：改用脚本编译后成功，烧录后可正常带翻转入场；后续编译建议统一走脚本，避免依赖漏带。

## 结论、注意事项与遗留问题

### 结论

- ST7567 适配的「难点」不在新增一个设备文件，而在于：**同一套 page 协议下两块屏的列命令字节序与亮暗语义相反；背光脚又与加热脚编号相邻，沿用旧默认值会造成硬伤。**
- 正确做法是**先把 mono 刷屏升格为 `MONO_COG` 公共算法**，再为 ST7567 接上正确的 128×48、列序、极性、A6 与 GPIO24，并打通 `Post → AP handoff → ATE/XUi` 的配置链。
- 告警灯的实现边界是**跨仓成对**：xGui 定义灯脚名单，smp 解析并驱动，PWM 与加热联动都在 smp 侧收口。
- 硬解码通路的可用分辨率**不能只看解码成功率**：720P 成功率最高但丢帧率高达 73.3%，800×480 错误最多（成功率 82.4%），需按现象与数据同时取舍。

### 注意事项

1. **三仓宏必须一致**：smp 开了 `ST7567`/`MONO_COG`，而 xapp 仍是 `__NO_SCREEN_SUPPORT__` 或 xGui 未认 ST7567，会出现「有驱动无 UI」或编译失败/跑错设备。
2. **SPI 面板互斥**：同一产品只能开一块 SPI 屏，设备表中多块 mono 依赖上层「只选一块」。
3. **背光脚**：MB12-V2 一律 GPIO24；任何「默认 GPIO22」的拷贝都会点加热器。
4. **A7**：仅 ST567 发；ST7567 保持 A6 正显。
5. **QSPI mapping / partial**：mono 均不支持。
6. **handoff**：`SKIP_HW_RESET` 跳过 init 时初始化责任在 Post，冷启异常路径需回归。
7. **构建一致性**：Kconfig=y 但 CMake 漏加源文件会链接缺符号；xapp 常在 ignore/子仓，合入遗漏会导致「本地能编、CI 无屏」。
8. **资源与分区**：开启 LVGL + `DISPLAY_DRAW` + FrogFS 后 Flash/PSRAM 压力上升，图标未按 128 屏重做会裁切。

### 遗留问题与待板测项

1. Post Logo 的方向、黑白与缩放锯齿是否可接受。
2. 冷启 / 异常 OTA 后 AP 是否仍能正确 init。
3. XUi 主界面是否反色、是否裁切；**大量控件仍按大屏思维写死**，小屏上重叠/裁切/不可点，酒店 UI 等复杂页未逐页验证。
4. ATE 预选 blank 与测项上屏、PWM/GPIO 双背光路径一致性。
5. **确认 GPIO13 LDO 投票在 MB12-V2 上无副作用**（是否真有 LCD LDO 待硬件确认）。
6. 加热脚 GPIO22 在亮屏全程不受背光逻辑影响。
7. 全量刷机后分区与 FrogFS 资源是否完整。
8. 硬解码：在「解码错误」与「丢帧」之间确定最终可用分辨率，并确认崩溃（白屏）是否由解码错误累积导致。
9. UI 水平翻转的完整依赖清单尚未沉淀为可复用的编译步骤，仍依赖脚本。

## 附：信息不足的源文件

| 源文件 | 信息不足点 |
|--------|------------|
| `20260402-T121114-LCD屏幕ui支持水平翻转.txt` | 内容为零散操作记录，末尾中断（「因为有一些」后无内容）；缺少现象的确切日志、`zygote` 崩溃的完整堆栈、依赖缺失的具体条目，以及翻转前后 UI 布局是否重排的说明；编译/烧录步骤为一次性经验，未给出可复现的最小步骤。 |
| `硬解码部分.txt` | 多次粘贴拼合，部分数据行不完整（末尾出现孤立的两行 ENCODE 峰值/稳态数据，无表头与单位归属）；同一组统计存在两个版本（一处为「解码增加 +73KB，剩余 180KB」，一处为「+82.63 KB，剩余 133 KB」），未注明各自对应的固件版本与测试条件；段落与分辨率无关地混排；GC2145 分辨率列表未说明哪些已实测通过。 |
| `MB12-V2-ST7567屏幕适配原理说明.md` / `MB12-V2_ST7567_屏幕适配_021f596.md` | 两份文档内容高度重叠但未标注版本关系；均为**适配前的风险推演与逐文件说明**，缺少板测实测结果（如是否真出现花屏/反色及最终确认方式）；多条「隐患」以「需确认/需硬件确认」结尾，属未闭环项。 |
| `MB12屏幕调试.md` | 为规格书/原理图/代码三方对齐笔记，只有结论表；未包含调试过程中失败与返工的记录。 |
| `MB12-V2_LED告警灯_smp_xGui.md` | 给出了 conf 片段与联动逻辑，但未给出 `bk_ate_led.c` 中 PWM 解析函数的实际实现与错误处理细节；`OUTPUT_GPIO3/4`（55、19）功能语义仅称「状态/告警输出」，具体对应哪颗灯未明确。 |
