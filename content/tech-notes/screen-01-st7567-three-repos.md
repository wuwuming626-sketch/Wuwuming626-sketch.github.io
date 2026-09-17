+++
title = '屏幕-01 ST7567 三仓改动总结'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 1
+++

MB12-V2 的 ST7567 是 128×48 SPI 单色 COG 屏，背光走 PWM4 → GPIO24。产品此前按「无屏 / 假屏」路径编译，显示链路只有 ST567 与 ST7789P3 两条分支。这次把 ST7567 接成第三种 mono COG 面板。下面把整条链路和踩过的坑记一遍。

> 覆盖三个仓库：`bk_avdk_smp`（`fc3f8e6e318c9beabc538b3b1d77bc131ebc1cf3` / `I8d16c16661debd797654276d019c7ea317485961`）、xapp（`a1ea773037b8e7b0f5a8d3174111e535479cef42` / `Icf8c7bd5770fc5b5f777cd30f871fd2a52634a1d`）、xGui（`275ee548a1eb290f3f75b0693f2964547d4ce2eb` / `I7f870f2cd04d769634e9b998d6e614d77b45f00c`）。

## 概述

MB12-V2 使用 **ST7567 128×48 SPI 单色 COG 屏**，背光由原理图 `PWM4 → GPIO24` 引出。此前的产品配置按「无屏 / 假屏」路径编译（`X_LCD_DISABLE`、`__NO_SCREEN_SUPPORT__`、`X_SCREEN_DUMMY`、`X_NO_FONT_MODULE`），显示链路只有 V50E 的 ST567（132×64）与 V60E 的 ST7789P3（240×320 彩屏）两条分支。

本次改动把 ST7567 作为**第三种 mono COG 面板**接入，并打通三段链路：

```text
上电 Post：ST7567 init(A6) → 开机 logo（尺寸不符则缩放）→ GPIO24 点亮背光
AP 接手： LCD_SKIP_HW_RESET（不重复 panel init，保留 GRAM）→ xapp mono 宏 → xGui mono 画屏 128×48
ATE 预选：STANDALONE_UI 有屏预选；同屏二值化后 flush；背光可用 PWM4 测亮度档
```

针对 ST567 与 ST7567 的共性（同为 mono COG、页写刷屏、同样只支持全帧 flush），改动引入了一个**聚合开关 `CONFIG_LCD_SPI_MONO_COG`**，把原先散落的 `CONFIG_LCD_SPI_ST567` 判断统一替换为 MONO_COG，再用内层 `CONFIG_LCD_SPI_ST7567` / `CONFIG_LCD_SPI_ST567` 区分差异点（刷屏参数、极性、A7）。

三仓分工：

```text
Post / 驱动 / ATE / 产品 Kconfig   → bk_avdk_smp   （27 个文件）
业务侧编译宏（有屏 / mono）         → xapp          （1 个文件）
真正画 UI + 布局常量 / 字体          → xGui          （3 个文件）
```

## 各仓改动总览（表格）

### bk_avdk_smp（27 个文件）

| 文件 | 类型 | 改动要点 |
|------|------|----------|
| `ap/components/bk_peripheral/include/lcd_panel_devices.h` | 改 | `#if CONFIG_LCD_SPI_ST7567` 下 `extern const lcd_device_t lcd_device_st7567;` |
| `ap/components/bk_peripheral/src/lcd/lcd_panel_devices.c` | 改 | 条件编译把 `&lcd_device_st7567` 挂进全局面板设备表，使探测/枚举可见 |
| `ap/components/bk_peripheral/src/lcd/spi/Kconfig` | 改 | 新增 `LCD_SPI_ST7567`（default n）与静默 `LCD_SPI_MONO_COG`（`default y if LCD_SPI_ST567 \|\| LCD_SPI_ST7567`）；原 ST567 配置块重排上移 |
| `ap/components/bk_peripheral/src/lcd/spi/config.cmake` | 改 | `CONFIG_LCD_SPI_ST7567` 为真时把 `lcd_spi_st7567.c` 加入 `SPI_LCD_DEVICE_FILES` |
| `ap/components/bk_peripheral/src/lcd/spi/lcd_spi_st7567.c` | **新增** | 128×48 面板描述 + 厂商 init 命令表；`clk = LCD_QSPI_20M`、`frame_len = 128*48*COLOR_DEPTH_BYTE`、`lcd_device_st7567` 导出（`init/off = NULL`） |
| `ap/components/bk_thirdparty/bk_ate/include/bk_ate_hw_version.h` | 改 | MB12 ATE 硬件表新增 `{ "LCD_BACKLIGHT_GPIO", 0, 24, 0, 0 }` |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_preselect_ui.c` | 改 | blank 屏条件由 `CONFIG_LCD_SPI_ST567` 换成 `CONFIG_LCD_SPI_MONO_COG` |
| `ap/components/bk_thirdparty/bk_ate/src/bk_ate_voip_display.c` | 改 | 选屏加 ST7567 分支；背光脚/PWM 通道按面板区分；二值化与 skip-swap 符号泛化为 mono；仅 full-frame |
| `ap/include/driver/lcd_types.h` | 改 | `lcd_device_id_t` 新增 `LCD_DEVICE_ST7567`（128X48 SPI mono） |
| `ap/middleware/driver/lcd/lcd_spi_driver.c` | 改 | 新增 `lcd_spi_is_mono_cog()`；每设备 mono 刷屏参数；页写列地址顺序与像素极性分面板处理；mono 走 8M baud、不设 CASET/RASET、不支持 QSPI 映射与局部刷 |
| `projects/qemu_voip/ap/CMakeLists.txt` | 改 | `CONFIG_LCD_SPI_MONO_COG` 时链接 `xui_bkScrn_mono_draw.c` |
| `projects/qemu_voip/ap/ap_main.c` | 改 | 启动早期 `backlight_enable()` 点亮 GPIO24，减少黑屏等待 |
| `.../mb12-v2/ap/config/bk7258_ap/config` | 改 | 开 `LCD_SPI_ST7567` / `LVGL_VOIP` / `LV_COLOR_16_SWAP` / `LVGL_FRAME_BUFFER_NUM=2` / `PWM` / `LCD_SKIP_HW_RESET` / `APP_DISPLAY_DRAW(_SOFTWARE)` / `MEDIA_OSD` / ATE `STANDALONE_UI`；关 `LCD_QSPI`、`LCD_SPI_REFRESH_WITH_QSPI(_MAPPING_MODE)`、ATE I12 |
| `.../mb12-v2/ap/config/bk7258_ap/usr_gpio_cfg.h` | 改 | GPIO14/15/16/17/23 改为 `SECOND_FUNC_DISABLE + GPIO_DEV_INVALID` 交 display/ATE 接管；P24 设为输出（背光）；P22 保持加热 |
| `.../mb12-v2/post/config/bk7258_post/config` | 改 | 打开 `CONFIG_LCD` / `CONFIG_LCD_SPI` / `CONFIG_LCD_SPI_ST7567` / `CONFIG_POST_LCD`；QSPI 刷屏关闭 |
| `.../mb12-v2/post/config/bk7258_post/usr_gpio_cfg.h` | 改 | Post 侧 GPIO24 由 IO_DISABLE 改为 OUTPUT_ENABLE（背光） |
| `projects/qemu_voip/partitions/bk7258/auto_partitions.csv` | 改 | ota 4336k→4464k，userdata 2040k→1912k（对称挪 128k） |
| `.../xapp_stub/product_build_resource/mb12-v2/productprop.txt` | 改 | 新增 `sys.screen.resolution.ratio=128*48` |
| `.../xapp_stub/product_extra_mk/mb12-v2_extra.mk` | 改 | 删除 `X_SCREEN_DUMMY`、`X_NO_FONT_MODULE`；新增 `X_FROGFS_PIC_SUPPORT`、`XUI_FROGFS_ICON_1TO1` |
| `.../xapp_stub/screen_font_stub.c` | 改 | 字宽测量门控由 ST567 换成 MONO_COG |
| `.../xapp_stub/scrn_pwm_backlight.c` | 改 | ST7567 分支下 `hwBackLightSet()` 改为纯 GPIO 开关（GPIO24），非 PWM |
| `projects/qemu_voip/post/Kconfig` | 改 | Post LCD 帮助文本补充 ST567/ST7567 |
| `projects/qemu_voip/post/app/post_logo_show.c` | 改 | mono 保原生 RGB565（不做 R/B 与字节交换）；新增 `post_logo_scale_to_panel()` 最近邻缩放 |
| `projects/qemu_voip/post/app/post_text_show.c` | 改 | mono COG 统一条件；`FONT_SCALE=1`、坐标恒等映射；`LOG_W/LOG_H` 注释放宽到 128/48 |
| `projects/qemu_voip/post/board/lcd/post_lcd_drv.c` | 改 | 选屏加 ST7567；背光统一为 `post_lcd_backlight_apply(bool)`；ST7567 清屏填 0xFF；删除调试 dump 日志 |
| `projects/qemu_voip/post/board/lcd/post_lcd_drv.h` | 改 | 新增 ST7567 几何/背光宏（BL=24、128×48、FRAME_SIZE）；补全 ST567 / ST7789P3 分支 |
| `projects/qemu_voip/post/board/logo/mb12-v2/vendor_logo.jpg` | **新增（二进制）** | 开机 logo，打进 64k 的 logo 分区，不占 ota 增量 |

### xapp（1 个文件）

| 文件 | 类型 | 改动要点 |
|------|------|----------|
| `ap/components/bk_thirdparty/xapp/mkrules/mb12-v2_config.mk` | 改 | 删 `X_LCD_DISABLE`、`__NO_SCREEN_SUPPORT__`；增 `__MONO_LCD_SUPPORT__=1`、`X_LVGL_MONO_MAIN_SCRN=0`、`__SPI_PANNEL_ST7567__=1`、`__SPI_PANNEL_ST567__=0`、`__PANNEL_INIT_OFF_BL__=1`、`X_DSSKEY_ICON_CUSTOM_SUPPORT=1` |

### xGui（3 个文件）

| 文件 | 类型 | 改动要点 |
|------|------|----------|
| `src/xuiDraw/xui_bkScrn_mono_draw.c` | 改 | `#error` 门控换 MONO_COG；新增 `BK_SCRN_MONO_LCD_DEVICE` 面板宏；帧宽高、SPI 控制器 `.lcd_device` 全部改用该宏；`bk_scrn_st567_prepare_gpio` 更名 `bk_scrn_mono_prepare_gpio`，A7 仅 ST567 发 |
| `src/xuiDraw/xui_lvgl_font.c` | 改 | 6 处字体路径/加载/选字体/字宽测量的条件编译由 ST567 换成 MONO_COG |
| `tools/constant/mb12-v2_product_constant.txt` | 改 | `WIN_MAX_WIDTH/HEIGHT` 480/320→128/48；补 `XUI_TITLE_LINE_Y`、`PIC_STRETCH_VALUE_OFF`、列表比例宏与一套 IME 输入框布局宏 |

## 技术流程

### 面板资源与硬件映射

| 项 | 取值 |
|----|------|
| 面板 | ST7567 COG，128×48，SPI 单色 |
| SPI | SPI0（`POST_LCD_SPI_ID` / `spi_id = 0`），`SPI_POL_MODE_0`，mono 强制 8M baud |
| DC（RS） | GPIO17（手工 GPIO，`gpio_spi_sel(GPIO_SPI_MAP_MODE0)` 后 `gpio_dev_unmap` 再置输出高） |
| RESET | GPIO23 |
| 背光 | GPIO24（原理图 PWM4）；ATE 路径使用 PWM 通道 4，产品路径用纯 GPIO 开关 |
| LDO | `bk_pm_module_vote_ctrl_external_ldo(GPIO_CTRL_LDO_MODULE_LCD, LCD_LDO_PIN=GPIO13, HIGH)` |
| 帧缓冲 | RGB565，128×48×2 = 12288 字节 |

MB12 上 GPIO22 是加热控制（`heat_ctrl_gpio`，低有效），因此**不能沿用 V60E 的背光 PWM2/GPIO22**，这是所有背光相关分支必须按面板区分的原因。

### 驱动初始化时序（ST7567）

新文件 `ap/components/bk_peripheral/src/lcd/spi/lcd_spi_st7567.c` 中的 init 表，逐条对应厂商 `scrn_MonoScrn_drv.c` 里的一次 `lcdWriteCmd()`：

```c
static const lcd_qspi_init_cmd_t st7567_init_cmds[] = {
    {0xE2, {0x00}, 0},   /* 软复位 */
    {0xAE, {0x00}, 0},   /* Display OFF */
    {0xEE, {0x00}, 0},   /* 退出读改写模式 */
    {0xA2, {0x00}, 0},   /* Bias 1/9 */
    {0xA0, {0x00}, 0},   /* SEG 方向正常 */
    {0xC0, {0x00}, 0},   /* COM 输出方向正常 */
    {0xA6, {0x00}, 0},   /* 正显（Normal） */
    {0x24, {0x00}, 0},   /* 对比度相关 */
    {0x81, {0x00}, 0},   /* 电子音量 —— 与下一行为两条独立命令 */
    {0x18, {0x00}, 0},   /* 电子音量参数值 */
    {0x2F, {0x00}, 0},   /* 电源控制全开 */
    {0xF8, {0x00}, 0},   /* 升压比命令 */
    {0x01, {0x00}, 0},   /* 升压比参数 */
    {0x40, {0x00}, 0},   /* 显示起始行 = 0 */
    {0xA4, {0x00}, 0},   /* 非全亮 */
    {0xAF, {0x00}, 0},   /* Display ON */
};
```

**关键点（文件头注释明确写了）：** 该表只有命令相位，**没有 DC 拉高的数据相位**；`0x81` 与 `0x18` 是两条独立命令，不是 `0x81 + data` 的两字节写。若按彩屏惯例把 `0x81` 当「命令 + 参数」下发，对比度设置会失效或错位。

初始化/刷屏的完整时序（以 AP 侧为例）：

```text
bk_display_open()/lcd_spi_driver_init()
  ├─ lcd_spi_is_mono_cog(id) → bk_spi_set_mode(SPI_POL_MODE_0) + baud = 8M（日志 [before_mono_cog_baud]）
  ├─ (CONFIG_LCD_SKIP_HW_RESET 时) 跳过 panel init_cmd，保留 Post 已写好的 GRAM
  ├─ mono 分支：不下发 CASET/RASET 窗口命令（走页写）
  ├─ display_area 仅对非 mono 面板设置
  └─ 结束后打印实际时钟（lcd_spi_log_spi_clk）
prepare_mono_gpio()
  ├─ gpio_spi_sel(GPIO_SPI_MAP_MODE0)
  ├─ gpio_dev_unmap(DC) → bk_gpio_enable_output(DC) → DC 拉高
  └─ 仅 ST567 追加 0xA7；ST7567 保持 A6（init 表已含），不发 A7
```

### SPI / GPIO 配置

- **引脚 handoff：** 产品侧 `usr_gpio_cfg.h` 把 GPIO14/15/16/17/23 从 `GPIO_DEV_LCD_*` 改为 `SECOND_FUNC_DISABLE + GPIO_DEV_INVALID`，即启动阶段**不抢占**这些脚，交由 display/ATE 自行接管（与 V50 的 handoff 方式一致）。GPIO24 在产品侧设为 `GPIO_OUTPUT_ENABLE`，Post 侧也在自己的配置表里把它由 IO_DISABLE 改为输出。
- **SPI mux：** 刷屏前统一执行 `gpio_spi_sel(GPIO_SPI_MAP_MODE0)`，把 SPI0 复用回 LCD 引脚。
- **QSPI 相关开关必须关闭：** `CONFIG_LCD_QSPI`、`CONFIG_LCD_SPI_REFRESH_WITH_QSPI`、`CONFIG_LCD_SPI_REFRESH_WITH_QSPI_MAPPING_MODE` 全部置 `is not set`；驱动侧在 `CONFIG_LCD_SPI_REFRESH_WITH_QSPI_MAPPING_MODE` 下对 mono 直接报错返回（页写与 QSPI 映射模式不兼容）。
- **帧缓冲 DMA：** Post 侧 `post_lcd_show_logo()` 在调用 `bk_lcd_spi_frame_display()` 前把数据 `os_malloc` + `memcpy` 到 RAM，因为 SPI DMA 源要求 `DMA_DEV_DTCM`；刷屏后延时 10ms 再释放。
- **分档 PWM/GPIO 背光：** 产品路径（`scrn_pwm_backlight.c`）在 ST7567 下用纯 GPIO（`bk_gpio_pull_up` + 输出高/低），`s_level` 做去重，`MAX_BACKLIGHT_VALUE` 截断；ATE 预选 UI 路径（`bk_ate_voip_display.c`）改用 `LCD_BL_PWM_CHAN = 4`、周期 1000、5 档。

### 刷屏页写、坐标系与镜像/翻转

mono COG 全帧刷屏由 `lcd_spi_mono_cog_frame_display()` 承担（由原 ST567 专用函数泛化而来），核心是对每个 page（8 行像素）做二值化打包后按页写命令下发：

```c
/* 每设备参数：col_start / col_lsb_first / light_is_zero */
int light = lcd_spi_st567_rgb565_is_light(pix);   /* 2R+4G+B > 173 */
if (light_is_zero) { if (!light) { bbyte |= (1U << bit); } }   /* ST7567：亮→0，暗→1 */
else if (light)    { bbyte |= (1U << bit); }                    /* ST567：亮→1 */

bk_lcd_spi_send_cmd(id, (uint8_t)(0xB0u | page));
if (col_lsb_first) {   /* ST7567：先低 4 位，再高 4 位 */
    bk_lcd_spi_send_cmd(id, (uint8_t)(0x00u | (col_start & 0x0FU)));
    bk_lcd_spi_send_cmd(id, (uint8_t)(0x10u | (col_start >> 4)));
} else {               /* ST567：先高 4 位，再低 4 位 */
    bk_lcd_spi_send_cmd(id, (uint8_t)(0x10u | (col_start >> 4)));
    bk_lcd_spi_send_cmd(id, (uint8_t)(0x00u | (col_start & 0x0FU)));
}
bk_lcd_spi_send_data(id, line, w);
```

两个面板的差异只有三项，全部参数化成 `lcd_spi_disp_t` 的成员：

| 参数 | ST7567 | ST567 |
|------|--------|-------|
| `mono_col_lsb_first` | 1（先 `0x00\|低4位`，再 `0x10\|高4位`） | 0（先高后低） |
| `mono_light_is_zero` | 1（亮像素写 0） | 0（亮像素写 1） |
| 显示极性 | A6 正显，**不发 A7** | 需 A7 反显（bit=1 解释为 OFF=白），与 Post 一致 |

极性推导（源码注释）：A6 下 RAM 位 1 → 点 ON → 黑，白底会渲染成黑底；ST567 因此追加 A7 反显，使 bit=1 → OFF=白，与源图一致。ST7567 则通过「亮像素写 0」配合 A6 达到同样效果，因此**不能**再发 A7，否则整屏反相。

坐标系方面，mono COG 面板本身即为横向（landscape），坐标恒等映射（`log_to_phys(lx, ly) = ly * phys_w() + lx`），无旋转；只有 ST7789P3 需要 90° CW 旋转。xGui mono 画屏的注释也明确：「帧缓冲按面板尺寸分配，flush 时直接用 `frame->size`」，即不再假设固定的 132×64。

### 多仓协同与编译开关关系

```text
Kconfig: LCD_SPI_ST7567=y  ──┐
                            ├─→ LCD_SPI_MONO_COG=y（隐式，default y if ST567||ST7567）
Kconfig: LCD_SPI_ST567=y   ──┘
        │
        ├─ bk_peripheral：编入 lcd_spi_st7567.c；设备表挂 lcd_device_st7567
        ├─ lcd_spi_driver：mono COG 页写参数 / 8M baud / 跳过 panel init
        ├─ ATE：选屏、二值化、背光 PWM4、blank 屏、小屏判断
        ├─ ap/CMakeLists：链接 xui_bkScrn_mono_draw.c（否则回退 xui_bkScrn_draw.c 彩屏后端）
        ├─ xGui：BK_SCRN_MONO_LCD_DEVICE / 字体门控
        └─ xapp（另一套宏，非 Kconfig）：__MONO_LCD_SUPPORT__、__SPI_PANNEL_ST7567__、__PANNEL_INIT_OFF_BL__
```

要点：

1. **Kconfig 与 xapp 宏是两套体系**，必须同时改：Kconfig 决定驱动与 `CONFIG_*` 条件编译，xapp 的 `.mk` 决定业务层（有屏/无屏、面板型号、背光时序）编译路径。本次 xapp 侧删掉 `X_LCD_DISABLE` 与 `__NO_SCREEN_SUPPORT__`，显式声明 `__SPI_PANNEL_ST7567__=1` / `__SPI_PANNEL_ST567__=0`。
2. `X_LVGL_MONO_MAIN_SCRN` 显式置 0，表示不走该 mono 主界面旧路径，而是走 `MONO_COG + xui_bkScrn_mono_draw.c` 这条后端；这也是 `ap/CMakeLists.txt` 里用 MONO_COG 选后端文件的原因。
3. `__PANNEL_INIT_OFF_BL__=1` 表示 init 阶段先关背光，Post 显示完 logo 后再点亮，避免上电花屏被看到。
4. 分区：AP/XUi 体积增大，`ota` 从 4336k 扩到 4464k，`userdata` 对称从 2040k 缩到 1912k；logo 走独立的 64k `logo` 分区，不占 ota 增量。

### 上层 UI / 字体 / 坐标的衔接

- **布局常量：** `mb12-v2_product_constant.txt` 把 `WIN_MAX_WIDTH/HEIGHT` 由 480/320 改为 128/48，这是 mono_draw 里 `WIN_MAX_WIDTH != g_fb_w` 告警判据的来源；同时补齐 `XUI_TITLE_LINE_Y=5`、`PIC_STRETCH_VALUE_OFF=0`、`XUI_CLOG_INFO_LIST_ITEM_RATIO="1:3:0:4"`、`XUI_LIST_ITEM_RATIO="1:4:5"` 以及一组 `XUI_CLOUD_IME_INPUT_*` 编辑框/候选栏布局宏（宽 128、高 15/20 等），原因是小屏路径此前缺这些定义。
- **字体：** `xui_lvgl_font.c` 中三处字体加载与字宽测量、`screen_font_stub.c` 的 `xui_lvgl_str_line_width_px` 门控统一为 MONO_COG，保证 ST7567 也使用 9px/16px 二进制字库而非 LVGL 内建字体；同时 `xui_lvgl_str_line_width_px` 与 `bkScrnDrawString` 的字形步进保持一致。
- **图标：** 产品 extra.mk 打开 `X_FROGFS_PIC_SUPPORT` 与 `XUI_FROGFS_ICON_1TO1`，让 FrogFS 里的图标按打包尺寸 1:1 显示，避免 mono 小屏上被运行时拉伸。
- **Post 文本：** `post_text_show.c` 中 mono 分支固定 `FONT_SCALE=1`（8×16 像素/字符）、横向无旋转，`LOG_W/LOG_H` 注释放宽为 132/128 与 64/48。
- **Post logo：** mono 分支**不做** RGB565→BGR565 的 R/B 交换，也**不做**字节序交换（与 `post_text_show` 一致），直接把原生 RGB565 交给下游二值化；当 JPEG 尺寸与面板不符（源 logo 约 132×64，面板 128×48）时，另分配 `POST_LCD_FRAME_SIZE` 缓冲并调用 `post_logo_scale_to_panel()` 做最近邻缩放（先整屏填 0xFFFF 白底）。

### ATE 预选路径

`bk_ate_voip_display.c` 的改动：

```c
#if CONFIG_LCD_SPI_ST7567
#define LCD_BACKLIGHT_PIN   GPIO_24
#else
#define LCD_BACKLIGHT_PIN   GPIO_22
#endif

#if CONFIG_LCD_SPI_ST7567
#define LCD_BL_PWM_CHAN     ((pwm_chan_t)4)   /* PWM4 → GPIO24 */
#else
#define LCD_BL_PWM_CHAN     ((pwm_chan_t)2)   /* V60E：PWM2 → GPIO22 */
#endif
```

- 选屏：`bk_ate_voip_display_select_lcd()` 在 `CONFIG_LCD_SPI_COLOR_AUTO` 之后、ST567 之前插入 `#elif CONFIG_LCD_SPI_ST7567 → &lcd_device_st7567`。
- 小屏判定：`bk_ate_voip_display_is_small_panel()` 由「等于 ST567」改为分别判断 ST7567/ST567。
- 旋转：mono 一律 `ROTATE_NONE`。
- 刷屏前处理：`s_ate_st567_skip_flush_swap` 改名 `s_ate_mono_skip_flush_swap`；`lv_port_disp_ate_preprocess_frame()` 里改为运行期取 `bk_ate_voip_display_select_lcd()`，用 `lcd->width/height` 与帧缓冲尺寸比对后再做 `ate_mono_binarize_rgb565()`，同时置位 skip-swap，避免 LVGL 已按 SWAP 绘制时 flush 再 swap 一次。
- 渲染模式：mono COG 用 `RENDER_DIRECT_MODE`（整屏直接缓冲），其它面板 `RENDER_PARTIAL_MODE`；帧缓冲统一 `memset(..., 0xFF)` 清成白底。
- 顺序约束（注释保留）：`bk_ate_voip_display_prepare_mono_gpio()` 必须在 `bk_lcd_spi_init()` 之后调用，与 Post 侧 `post_lcd_drv` 的顺序一致。

## 调试过程记录

> 以下条目均来自改动本身的代码/注释所记录的问题与处置，按「现象 → 定位手段 → 根因 → 修改 → 验证结论」整理。

### 白底渲染成黑底（极性/反显）

- **现象：** ST567 类正显 mono 屏上，白底显示为黑、黑字显示为白。
- **定位手段：** 对照面板 init 命令与数据手册含义，确认 init 表用的是 `0xA6`（Normal）；再比对刷屏时 `rgb565_is_light()` 的打包规则（亮像素写 1）。
- **根因：** A6 下 RAM 位 1 → 段 ON → 黑，而打包规则把「亮」写成 1，两者叠加导致整幅图反相。
- **修改：** Post 与 xGui mono 路径在初始化完成后追加 `bk_lcd_spi_send_cmd(spi_id, 0xA7)`（Reverse），使 bit=1 → OFF=白。**该 A7 只对 ST567 生效**，用 `#if CONFIG_LCD_SPI_ST567` 包住。
- **验证结论：** 源码中保留的判断是「ST567 positive mono needs A7 reverse; ST7567 keeps vendor A6」，即两种面板通过不同手段达到白底黑字，互不通用。

### ST7567 上误发 A7 会整屏反相（新问题，随本次改动引入的规避点）

- **现象（设计规避）：** ST7567 沿用 A6 正显，若照搬 ST567 的 A7 会导致反相。
- **定位手段：** 对比厂商 `scrn_MonoScrn_drv.c` 的 init 表与页写函数，确认 ST7567 的「正显」是通过**亮像素写 0**（`mono_light_is_zero = 1`）实现的。
- **根因：** 极性由「面板反显命令」与「像素打包极性」两处共同决定，不能只调一处。
- **修改：** 把极性做成每设备参数 `mono_light_is_zero`；ST7567 = 1、ST567 = 0。三处发 A7 的位置（ATE、Post、xGui）全部只对 ST567 生效。
- **验证结论：** 三仓保持一致：Post（`post_lcd_drv.c`）、ATE（`bk_ate_voip_display.c`）、主界面（`xui_bkScrn_mono_draw.c`）均以 ST7567 正显、不发 A7 收尾。

### 列地址顺序不匹配导致画面错位

- **现象：** 按 mono 页写下发后，图像列方向整体错位/撕裂。
- **定位手段：** 对照厂商 `lcdWritePage()` 的字节序列。
- **根因：** 厂商 ST7567 页写顺序是 `0xB0|page`、`0x00|(col & 0x0F)`、`0x10|(col >> 4)`，**低 4 位先发**；而原 ST567 路径是先发 `0x10|高位` 再发 `0x00|低位`。
- **修改：** 引入 `mono_col_lsb_first` 参数，ST7567 置 1 走低先发分支，ST567 保持原顺序；同时把该顺序写进注释 `/* vendor ST7567 lcdWritePage: 0xB0|page, 0x00, 0x10, data */`。
- **验证结论：** 顺序差异被参数化收敛到 `lcd_spi_disp_t` 初始化处，面板差异不再散落在刷屏函数里。

### 清屏后页边界残留杂点

- **现象：** 上电清屏单次写入后，屏幕上下页边界偶尔残留零星亮点。
- **定位手段：** 原代码注释记录了这一点：控制器上电时 RAM 内容随机，单次整帧写入偶发无法覆盖页边界。
- **根因：** 上电 RAM 未初始化 + 页边界与整帧写入的对齐关系。
- **修改：** 保留「清屏调用两次」的做法（`post_lcd_clear_screen()`）；同时 ST7567 下**清屏缓冲填 0xFF（白）**而非 0x00：

```c
#if CONFIG_LCD_SPI_ST7567
    os_memset(clear_buf, 0xFF, frame_size);   /* A6：RAM 0 = 白 → 填白 */
#else
    os_memset(clear_buf, 0x00, frame_size);
#endif
```

- **验证结论：** 清屏极性不再是全局常量，而是按面板条件编译；ST7567 与 ST567 共用同一份清屏函数代码路径。

### 背光脚与加热脚冲突（GPIO22 vs GPIO24）

- **现象：** 沿用 V60E 的背光配置（PWM2 → GPIO22）在 MB12 上不可用。
- **定位手段：** 对照原理图与 `usr_gpio_cfg.h`：MB12 的 P22 是加热控制（`heat_ctrl_gpio`，低有效），背光走 PWM4 → GPIO24。
- **根因：** 背光脚是按产品原理图定的，不能跨产品复用。
- **修改：** 所有背光相关宏按面板/产品条件编译分流：产品侧 `BL_GPIO = GPIO_24`；ATE 侧 `LCD_BACKLIGHT_PIN = GPIO_24`、`LCD_BL_PWM_CHAN = 4`；Post 头文件新增 `POST_LCD_BL_GPIO = 24`；ATE 硬件版本表补 `LCD_BACKLIGHT_GPIO = 24`。同时 AP 启动早期就调用 `backlight_enable()`，避免上电后长时间黑屏。
- **验证结论：** 产品路径用纯 GPIO 开关（`hwBackLightSet()` 的 ST7567 分支不再走 PWM），ATE 路径保留 PWM4 用于实测亮度 5 档（`LCD_BL_PWM_PERIOD=1000`、`LCD_BL_PWM_LEVELS=5`）。

### Post 已初始化过面板，AP 重复 init 丢失 logo

- **现象（设计规避）：** Post 显示 logo 后交棒给 AP，AP 若再次下 init 命令会清掉 GRAM，logo 与启动文字被抹掉或闪烁。
- **定位手段：** 复用已有的 `CONFIG_LCD_SKIP_HW_RESET` 机制，把 mono 面板纳入跳过范围。
- **根因：** 面板 init 序列中的 `0xE2` 软复位与清屏会重置显示 RAM。
- **修改：** `lcd_spi_driver.c` 中 `if (device->id == LCD_DEVICE_ST567)` 改为 `if (lcd_spi_is_mono_cog(device->id))`，AP 产品配置打开 `CONFIG_LCD_SKIP_HW_RESET=y`，日志文案改为 `skip mono COG panel init_cmd (POST handoff, keep GRAM)`。
- **验证结论：** 同一辅助函数 `lcd_spi_is_mono_cog()` 被统一用于 5 处判断（8M baud、跳过 init、CASET/RASET、最终时钟、全帧/局部刷），ST7567 与 ST567 行为一致。

### 驱动刷屏不可用的组合（QSPI 映射 / 局部刷）

- **现象：** mono 面板启用 QSPI 映射模式时刷屏失败；调用局部刷接口返回失败。
- **定位手段：** 页写协议与 QSPI 映射模式（整帧直写 + 地址映射）不兼容；mono 采样需要按页组织。
- **根因：** mono 只有页写通路，无 CASET/RASET 窗口。
- **修改：** 驱动内在 `CONFIG_LCD_SPI_REFRESH_WITH_QSPI_MAPPING_MODE` 下打印错误并返回；`bk_lcd_spi_partial_display()` 对 mono 直接返回 `BK_FAIL`（日志 `mono COG only supports full-frame flush`）；产品配置关闭所有 QSPI 刷屏开关、关闭 `CONFIG_LCD_QSPI`。
- **验证结论：** 编译期与运行期双重约束：配置层关开关，驱动层用 `lcd_spi_is_mono_cog()` 兜底报错。

### 帧缓冲尺寸与面板不匹配（logo / 帧缓冲分配）

- **现象：** 开机 logo 源图为 132×64，目标面板 128×48，直接整帧下发会溢出/花屏；mono 路径也不应再做 R/B 与字节交换。
- **定位手段：** 比对 Post 既有 `post_text_show.c` 的 mono 数据处理方式（保原生 RGB565）。
- **根因：** 原 logo 路径假设「JPEG 尺寸 == 面板尺寸」，且按彩屏做了通道/字节交换。
- **修改：**
  1. mono 分支 `dst[x] = val;`（不交换），彩屏分支保持 R/B + 字节序交换；
  2. 新增 `post_logo_scale_to_panel()` 最近邻缩放：先整屏填 `0xFFFF`，再按 `sx = x * src_w / dst_w`、`sy = y * src_h / dst_h` 采样；
  3. 仅当 `entry->width/height != POST_LCD_WIDTH/HEIGHT` 时才额外 `os_malloc(POST_LCD_FRAME_SIZE)`，用完即释放。
- **验证结论：** 尺寸一致时零拷贝直接下发；不一致时走缩放缓冲，且分配失败有日志 `panel buf alloc failed`。

### 帧缓冲 DMA 依赖与调试日志清理

- **现象：** logo 数据直传有时刷屏异常；调试期间留有大量逐字节 dump 日志。
- **定位手段：** 注释记录「SPI DMA 源设备为 `DMA_DEV_DTCM`」，故需要先拷到 RAM。
- **根因：** DMA 源地址约束。
- **修改：** 保留 `os_malloc` + `os_memcpy` 再 `bk_lcd_spi_frame_display()` 的流程与 10ms 延时；同时删掉 `src[0..15]` dump、`data[mid..mid+7]` dump、`ram_buf` 完整性 `memcmp` 校验与 `frame_display returned` 等临时日志。
- **验证结论：** 调试期用过的字节级 dump 手段可以定位「数据是否为全白/数据是否被拷贝破坏」这一类问题，定位完成后应移除，避免刷屏路径上的日志开销。

### 小屏业务宏缺失导致的编译/布局问题

- **现象：** 打开 mono 小屏后，业务侧编译报缺少 `XUI_TITLE_LINE_Y`、`PIC_STRETCH_VALUE_OFF`、列表比例与 IME 布局宏；图标被拉伸；字宽测量走错分支。
- **定位手段：** 逐条比对 480×320 与 128×48 两条常量集；对照 FrogFS 图标打包尺寸。
- **根因：** 128×48 产品此前走「无屏/假屏」路径，常量集与字体/图标开关从未被真正使用过，缺口在切换到真屏后暴露。
- **修改：** `mb12-v2_product_constant.txt` 补齐缺宏并把 `WIN_MAX_*` 改到 128/48；extra.mk 打开 `X_FROGFS_PIC_SUPPORT` 与 `XUI_FROGFS_ICON_1TO1`（1:1 不拉伸）；`screen_font_stub.c`、`xui_lvgl_font.c` 的门控换成 MONO_COG。
- **验证结论：** 小屏常量集与 128×48 面板尺寸对齐；`WIN_MAX_WIDTH/HEIGHT` 与 `g_fb_w/g_fb_h` 不再不一致（否则 mono_draw 会打印 `panel != WIN_MAX` 告警并使用面板尺寸）。

### 编译空间不足

- **现象：** AP/XUi 体积增大后，原分区表打不下。
- **定位手段：** 对照 `auto_partitions.csv` 的 ota/userdata 边界。
- **根因：** 新增 mono 画屏后端、ST7567 驱动、字体/图标与 LVGL VoIP 栈带来的增量。
- **修改：** `ota` 4336k → 4464k，`userdata` 2040k → 1912k（对称挪 128k）；开机 logo 放 64k 的 `logo` 分区，不占 ota。
- **验证结论：** 与 logo 无关，仅 ota↔userdata 容量互换。

## 结论、注意事项与遗留问题

### 结论

1. ST7567 以「第三种 mono COG 面板」接入，驱动、Post、ATE、UI 四条路径全部打通，编译开关由 `CONFIG_LCD_SPI_MONO_COG` 统一收口，面板差异仅剩三项参数（列顺序、像素极性、A7）与背光脚。
2. 显示链路的三段边界清晰：Post 负责 init + logo + 点亮背光；AP 借 `CONFIG_LCD_SKIP_HW_RESET` 保留 GRAM 直接接管；ATE 复用同一套 mono 刷屏与二值化逻辑。
3. 所有硬件耦合点（背光 GPIO24/PWM4、SPI mux、DC=GPIO17、RESET=GPIO23、P22 留给加热）都已在配置与驱动两层显式区分，不再依赖 V60E/V50E 的隐式假设。

### 注意事项

- **不要给 ST7567 发 A7**：其正显靠 A6 + 亮像素写 0 实现，三处发 A7 的位置都必须保持 `#if CONFIG_LCD_SPI_ST567` 限定。
- **init 表是「纯命令序列」**：`0x81` 与 `0x18` 分两条下发，不能合并成命令+数据相位；新增命令时遵循同样的写法。
- **mono 只支持全帧刷屏**：不要对 ST7567/ST567 调用局部刷接口，也不要启用 QSPI 映射刷屏。
- **每设备刷屏参数在 `bk_lcd_spi_*_init()` 里初始化**，新增 mono 面板时必须同时设置 `mono_col_start`、`mono_col_lsb_first`、`mono_light_is_zero`。
- **`bk_ate_voip_display_prepare_mono_gpio()` 必须在 `bk_lcd_spi_init()` 之后**，顺序与 Post 侧一致。
- **背光时序**：`__PANNEL_INIT_OFF_BL__=1` 要求 init 阶段先关背光，Post logo 显示完成后再点亮；AP 早期另有一次 `backlight_enable()`。
- **刷屏取源数据需先拷到 RAM**（DMA 源为 `DMA_DEV_DTCM`），并保证 DMA 完成后再释放缓冲（当前用 10ms 延时）。
- **分区改动只涉及 ota/userdata**，logo 走独立 logo 分区。

### 遗留问题 / 待确认项

- Post 的 `post_lcd_drv.h` 中 V50E/V60E 的 `POST_LCD_BL_GPIO` 仍为 GPIO22，ST7567 才用 GPIO24；若后续其它产品复用小屏，需要再核对背光脚归属，避免与加热脚冲突。
- logo 源图与面板尺寸不一致时走的是**最近邻缩放**，在 132×64 → 128×48 这种非整数比下会有笔画粗细不均；如需更好效果需换成均值/双线性或直接提供 128×48 素材。
- 「清屏两次」是对控制器上电随机 RAM 的经验性规避，缺少理论上的收敛说明；若后续仍观测到边缘残点，需进一步确认是页对齐问题还是 RAM 初始化时序问题。
- mono 路径下的 8M 波特率沿用 `LCD_SPI_ST567_BAUD_RATE` 常量名（日志前缀已改为 `[before_mono_cog_baud]`），常量命名与实际语义已不完全一致，属可读性问题，不影响功能。
- 本文档仅覆盖三个提交所描述的改动，运行时表现（实际刷新率、闪烁、字体裁切等）需以真机验证为准。
