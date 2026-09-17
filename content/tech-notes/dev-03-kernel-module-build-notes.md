+++
title = '开发环境-03 内核模块与构建笔记'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 8
+++

屏幕不亮、花屏、Codec 不启动——这三个现象我都见过，可最要命的是它们彼此对不上号：按常理该同时出现的毛病，偏偏不同时出现。一路查到最后，原因朴素得让人想笑：平台烧错了。RK3506G 与 SSD201 的故事，先从构建体系讲起。

## 概述

本文整理嵌入式 Linux 产品（RK3506G / RK3502 系列、SSD201 系列等）在**内核构建与驱动开发**上的经验：Kconfig/Makefile/defconfig/DTS 各自负责什么、改哪里代码才会真正被编译、新驱动如何从原理图走到设备树并完成加载与验证，以及过程中踩过的坑。

- 构建体系：`defconfig` 决定编不编，`Makefile` 决定编哪个文件，`Kconfig` 提供开关，`DTS` 决定编完之后在板上怎么找到硬件。
- 驱动落地：以 I2C（PMIC / Codec / 功放）、I2S、SPI+RGB LCD、矩阵键盘 GPIO 为例，走一遍「原理图 → 数据手册 → 设备树 → 烧录 → 调试」。
- 验证手段：regmap / regulator / DRM / input / ALSA 的 debugfs 与 sysfs 节点，是判断驱动是否真正加载生效最快的方式。

文中 IP、MAC、目录、账号均为示例值或占位写法。

## 内核构建体系

### 四个文件的分工

| 文件 | 作用 | 新增驱动时要改的地方 |
| --- | --- | --- |
| `Kconfig` | 定义配置符号 `CONFIG_XXX`，决定 menuconfig 里能否看到该项 | 增加一条 `config` 项 |
| `defconfig` | 板级默认配置，是 `.config` 的种子 | 写入 `CONFIG_XXX=y` |
| `Makefile` | `obj-$(CONFIG_XXX) += xxx.o` 决定源码是否参与编译 | 新文件必须挂进来，否则改了不生效 |
| `DTS/DTSI` | 描述板级硬件：控制器有无、挂哪条总线、地址、引脚复用、中断 | 打开节点、加子节点、配 pinctrl |

平台 DTS 一般是分层的：SoC 公共部分放在 `rk3502.dtsi` 这类头文件里，板级文件先 include 再补充。启用 I2C0 的写法：

```dts
#include "rk3502.dtsi"

&i2c0 {
    status = "okay";
};
```

### 在设备树里描述一个 I2C 从设备

以 PMIC RK816 为例：由原理图确认它接在 i2c0 上，再由数据手册查到 I2C 地址为 `0x1a`，在 i2c0 节点下加子节点：

```dts
rk816: pmic@1a {
    compatible = "rockchip,rk816";
    reg = <0x1a>;
    status = "okay";
};
```

中断引脚（PMIC_INT）在原理图上接到 GPIO 并被复用，需要先通过 pinctrl 把它改回 GPIO 功能，同时打开 GPIO 控制器节点：

```dts
&gpio {
    status = "okay";
};
```

### 编译进内核 与 编译成模块

把驱动编译进内核，一般只动三处：`Kconfig` 加开关、`Makefile` 加 `obj-$(CONFIG_XXX) +=`、`defconfig` 打开 `=y`；DTS 里再打开对应节点。判断某个文件有没有被编进去，有一个很直接的土办法：在文件里随便加一行打印后再编译，如果编译产物毫无变化，说明这个文件根本没参与编译（曾遇到 `netif.c` 未被编译，只有头文件声明可见、实现不可见）。

模块方式则用 `insmod`/`rmmod` 动态加载，用 `lsmod` 看是否已加载、`dmesg` 看 probe 日志：

```bash
insmod xxx.ko          # 加载模块
lsmod | grep xxx       # 确认已加载
dmesg | grep -i xxx    # 看 probe / 报错日志
rmmod xxx              # 卸载（需先停用引用方）
```

字符设备驱动注册成功后会出现在 `/dev` 下，块/字符子系统也各自在 `/sys` 下暴露节点。开发板上常见的几类节点与用途：

| 节点 | 由谁创建 | 用途 |
| --- | --- | --- |
| `/dev/i2c-0` | i2c-dev | 用户态 i2cget/i2cset 直接读写 I2C |
| `/dev/input/eventX` | input 子系统 | 按键/触摸事件，配合 hexdump 验证 |
| `/dev/snd/pcmC0D0p` | ALSA | 放音/录音设备节点 |
| `/sys/class/regulator/*` | regulator 框架 | 读电压、核对电源域配置 |
| `/sys/kernel/debug/regmap/*` | regmap | dump 寄存器，验证驱动写入值 |

## 技术流程

### 通用五步法：原理图 → 数据手册 → 设备树 → 烧录 → 调试

1. **看原理图**：确认器件连到哪条总线（I2C/I2S/SPI）、引脚编号与复用信号名、供电与控制引脚、上下拉与保护器件。
2. **查数据手册**：拿到从机地址、寄存器定义、默认值、时序/初始化要求。
3. **配设备树**：打开控制器节点 → 配 pinctrl 复用 → 加子节点（compatible/reg/中断/regulator）。
4. **编译烧录**：确认分支与平台名后编译、烧录。
5. **调试验证**：用 sysfs/debugfs 读寄存器、量电压、看日志，双向核对。

### GPIO 与引脚复用

引脚是否能用，先看 pinctrl 有没有把它复用给目标控制器。以 RK816 的 PMIC_INT 为例：原理图上它接在 GPIO0_A2 且带 10kΩ 上拉到 3.3V、开漏输出，代码里追踪信号名 `I2C0_SCL_PMIC` 可定位复用位置，然后配置为 GPIO 功能并打开 gpio 控制器节点。

需要驱动电平的引脚（复位、使能、背光）本质上都是「先复用为 GPIO，再由驱动在 probe 里申请并拉高/拉低」。板级上还有若干固定电压的 fixed regulator 节点，例如 `vcc_sys` 作为 RK816 等模块的主输入电源，其描述也写在 DTS 中而不是代码里。

矩阵键盘是 GPIO 双向配置的典型例子：6×5 的扫描阵列（实际使用 28 键），行线 `GPIO0_B2~B7`、列线 `GPIO0_C0~C4`。扫描时依次拉高每一行、读所有列，读到高电平即该行列位置按键按下；因为硬件上只有双向二极管与去抖电容、缺少下拉电阻，所以必须启用内部下拉（`drive-inactive-cols`），否则未按下时列线电平不确定。软件上还要做约 30ms 消抖确认。

### LCD（RGB + SPI）配置

屏幕走「RGB 数据 + SPI 初始化」：数据线 6bit（`LCD_DB0~DB5` 分别对应 `GPIO1_B4/B0/A7/A6/A5/A4`），控制信号 DE/VSYNC/HSYNC/PCLK 分别复用为 `GPIO1_A0`、`GPIO2_A0`、`GPIO3_A0`、`GPIO4_A0`，SPI2 三线（CLK/CS/MOSI 在 `GPIO2_B0/B1/B2`），复位 `GPIO1_C7`。

DTS 里除了 spi2 控制器、panel 节点，关键是 panel 的初始化/退出序列与时序参数。时序可以按公式核算，例如 240×320 @60Hz：

```text
Htotal = HPW + HBP + HFP + Hactive
最小值：6+12+6+240 = 264    典型值：30+30+60+240 = 360
Vtotal = VPW + VBP + VFP + Vactive
最小值：1+1+1+320 = 323      典型值：4+4+8+320 = 336
clk = Htotal × Vtotal × 60
最小值：264×323×60 = 5116320   典型值：360×336×60 = 7257600
```

屏初始化失败时，可适当放宽这些时序值。`panel-init-sequence` 每行格式为：指令类型（`00` 命令 / `01` 数据）、延迟(ms)、数据长度(byte)、数据。该序列主要由屏厂提供，我们只需要知道花屏、镜像翻转该去哪里改、去屏幕数据手册命令表里查哪条命令。

### 音频链路（I2S + I2C）

主控负责音频数据处理与时钟生成，Codec/功放由 I2C 配置寄存器、由 I2S 传输数据。设备树需要三块配置：I2C 控制器（Codec 与功放分别挂在不同 I2C 上）、引脚复用、I2S 控制器。例如 Codec 的地址由 CE 引脚电平决定（CE 默认高电平时地址为 `0x17`），需按数据手册核对。

### 编译与烧录

一套常见的平台构建流程如下（脚本名与参数按平台替换）：

```bash
repo init -m <平台>_cicd.xml
repo sync -c --no-tags -j12 --force-sync
repo forall -c "git status"
./build.sh -p <平台> -t all            # 编译全部
```

工程较复杂时先编单个应用验证环境，再编整体，可减少一次失败的等待时间：

```bash
./build.sh -p <平台> -t pkg x_app      # 先编应用
./build.sh -p <平台> -t all            # 成功后再编全量
```

构建环境需在容器内先 source 环境再 lunch 目标；跨版本同步后若编译报模块定义冲突，一般是仓库里有改动没同步过来，用 `git am -k` 把对应补丁打上再编。

## 问题与调试记录

### 屏幕不亮：先量电源，再查背光

- **现象**：烧录后屏幕不亮。
- **定位**：读 regulator 电压 `cat /sys/class/regulator/regulator.9/microvolts`，结果为 3.3V，与原理图一致，说明面板供电正常。
- **根因**：背光控制没有打开。
- **验证**：补上背光使能后正常点亮。

结论：不亮先分「面板供电 → 背光 → 初始化序列」三段排查，不要一上来就怀疑 DTS。

### 屏幕花屏：初始化序列不完整

- **现象**：烧录后花屏。
- **定位**：查看 `panel-init-sequence`，其中只有三条：退出睡眠（`0x11`）、开启显示（`0x29`）、开始写显存（`0x2C`）。
- **根因**：缺少关键配置——扫描方向（`0x36`）、像素格式（`0x3A`）、时序参数（`0xB0~0xB2`）以及伽马校正（`0xE0/0xE1`）均未设置，面板无法正确解析数据，颜色与时序都异常。
- **解决**：按屏幕数据手册的命令表补齐序列（该部分通常由屏厂提供）。
- **验证**：重新烧录后显示正常。

### PMIC 寄存器与 DTS 值不一致的核对方法

- **目的**：确认 RK816 各电源域电压与设备树配置一致。
- **手段**：通过 regmap、i2c 工具双向读取寄存器，并与数据手册默认值比对：

```bash
cat /sys/kernel/debug/regmap/0-001a/registers   # dump 全部寄存器
cat /sys/kernel/debug/regulator/regulator_summary
i2cget -f -y 0 0x1a 0x3b                        # LDO1_ON_VSEL_REG
```

- **分析**：读到 `0x2A = 0010_1010`，低 5 位 VSEL=01010(10)，按 `V = 0.8V + VSEL×0.1V` 得 1.8V；Bit6=1 表示电流限制 130%，Bit5=0 表示禁用放电电阻，与 DTS 配置一致。
- **验证**：再用万用表测各电源域电容位置电压（如 1.79V / 1.37V / 3.27V 等），与寄存器计算值和 DTS 三方吻合。

### Codec 不启动：节点被自己关过

- **现象**：音频无声，Codec 未启动。
- **定位**：排查 DTS，发现之前学习 I2C 子系统时把 Codec（RK730）节点关掉了。
- **根因**：I2C 从设备节点 `status` 非 `okay`，驱动不会 probe。
- **验证**：恢复节点后 `aplay -l` / `arecord -l` 能列出声卡。

### 功放寄存器读不到：要先使能

- **现象**：读取功放内部寄存器异常/无意义。
- **解决**：先使能再查询，读值才有意义。

```bash
echo 1 > /sys/bus/i2c/drivers/oca72xxx_pa/2-0058/hwen
cat /sys/bus/i2c/drivers/oca72xxx_pa/2-0058/reg
```

功放还支持按场景切换 profile（`Off` / `Music` / `Voice` / `Receiver`），配置路径同样在 sysfs 下。

### 录音无 ADC Switch 控件

- **现象**：按文档要开 `ADC Switch`，但 `tinymix contents` 输出里没有这个控件。
- **定位**：模糊搜索相关控件，确认控件命名与文档不一致。
- **解决**：改用现有控件逐项配置通路（关闭旁路、数字音量、模拟增益、麦克风偏置与输入选择等），再录音验证：

```bash
tinymix contents | grep -i "adc\|mic\|input\|capture"
tinymix set 57 Off
tinymix set 46 200 200
tinymix set 41 4 4
arecord -D hw:0,0 -f S16_LE -r 16000 -c 2 test.wav
aplay test.wav
```

结论：控件编号会随 codec 驱动版本变化，一切以 `tinymix contents` 的实际输出为准，不能照搬文档编号。

### 改了源码却「没反应」：文件未被编译

- **现象**：头文件已能识别到函数声明，但链接/行为上找不到实现；在某 `.c` 文件里加一行内容后编译依旧成功。
- **定位**：在实现文件里加一行简单语句再编译，编译结果无变化。
- **根因**：该文件没有被加入编译（未挂到 Makefile / 未被模块引用）。
- **解决**：把它加入编译后重新构建。

### 现象对不上：先确认烧的是哪个版本

- **现象**：同一功能在不同板子上表现不一致，甚至出现段错误。
- **定位**：核对烧录路径，发现选了错误平台（想烧 v65，实际烧成 v62w）。
- **解决**：改为正确平台重新烧录。
- **验证**：烧录方式（如换用 sigmaster）与平台名确认后现象复现一致。

教训：出现「不可能的差异」时，先排除版本/平台/烧录路径，再怀疑代码。

### 蓝牙 RSSI 获取失败

- **现象**：`hcitool rssi <MAC>` 报错，日志为 `Get connection info failed: No such file or directory`。
- **定位**：链路是 用户态 → BlueZ → HCI socket → 内核 HCI 核心（`hci_core`）→ 蓝牙芯片固件，RSSI 必须基于已建立的 ACL/SCO 链路：先取连接句柄（`ioctl(HCIGETCONNINFO)`），再发 `HCI_OP_READ_RSSI`。无连接时句柄无效，直接报错。
- **根因**：代码只在扫描到目标 MAC 后就判定通过，未建立连接，也没有获取 RSSI 的逻辑。
- **解决**：调整为「扫描 → 建立连接 → 获取 RSSI → 断开 → 判定范围」，并在连接成功之后调用 RSSI 获取函数；同时把连接检查从仅 RFCOMM 放宽为 RFCOMM 或 ACL。
- **验证**：`hcitool cc` 后再 `hcitool rssi` 返回有效值（如 -29 dBm）；上层能拿到值并上报产测结果。

内核侧排查命令：

```bash
lsmod | grep bluetooth         # 内核蓝牙模块是否加载
dmesg | grep -i blue           # 驱动 probe 与 HCI 报错
hciconfig -a                   # 控制器是否 up
hcitool cmd 0x04 0x0001        # 读本地特性，确认支持 RSSI/加密/安全连接
```

另外还有一类「扫不到设备」的情况：板子没有焊接天线，必须把设备贴近板载蓝牙处才能扫到；补焊天线后距离才恢复正常（硬件问题，不要误判为驱动问题）。

### 跨版本同步导致编译报错

- **现象**：换用新版本 xml 同步后编译失败，先是缺编译脚本，然后提示缺模块清单文件，编译阶段又报两个 `Android.bp` 模块定义冲突。
- **根因**：目标仓库里少同步了两个已有改动。
- **解决**：进入对应仓库目录，用补丁方式把改动带过来再编：

```bash
git am -k <补丁目录>/*
```

- **验证**：重新编译通过，产物时间更新为当前。

## 命令速查

| 场景 | 命令 |
| --- | --- |
| I2C 总线/设备 | `i2cdetect -l`、`i2cdetect -y 0` |
| I2C 读寄存器 | `i2cget -f -y 0 0x1a 0x3b` |
| I2C 写寄存器 | `i2cset -f -y 0 0x1a 0xe1 0x11` |
| I2C 全量 dump | `i2cdump -f -y 0 0x1a` |
| regmap 寄存器 | `cat /sys/kernel/debug/regmap/0-001a/registers` |
| 电源域/电压 | `cat /sys/kernel/debug/regulator/regulator_summary` |
| 单路电压 | `cat /sys/class/regulator/regulator.9/microvolts` |
| DRM/显示状态 | `cat /sys/kernel/debug/dri/0/summary`、`ls /sys/class/drm/` |
| 输入设备 | `cat /proc/bus/input/devices`、`hexdump /dev/input/event0` |
| 声卡/控件 | `aplay -l`、`arecord -l`、`tinymix contents` |
| 蓝牙控制 | `hciconfig -a`、`hcitool scan`、`hcitool cc <MAC>`、`hcitool con` |
| 蓝牙抓包 | `hcidump -w btlog.cfa &` |
| 文件回传主机 | `tftp -pr btlog.cfa 10.0.0.10` |
| 模块加载 | `insmod xxx.ko`、`lsmod`、`rmmod xxx`、`dmesg` |
| 代码同步/编译 | `repo sync -cd -j8`、`./build.sh -p <平台> -t all` |

## 注意事项

1. **新增源文件务必挂 Makefile**：头文件能找到声明 ≠ 实现被编译；「加代码无反应」优先查这一步。
2. **DTS 改动要重新编译并替换**：DTS 编成 dtb 与内核一起打包，验证以启动日志/`dmesg` 为准，不能只看配置文本。
3. **引脚复用是排他的**：同一引脚被占用于两个功能时，后申请者失败；调试新外设前先确认 pinctrl 与已有节点。
4. **寄存器值与 DTS 要双向核对**：读寄存器、看 `regulator_summary`、再量实际电压，三方一致才算配置生效。
5. **慎用 `-f` 强制访问 I2C**：设备已被内核驱动占用时强制读写可能引发冲突，仅用于诊断。
6. **屏初始化序列以屏厂为准**：花屏、镜像翻转优先查 `panel-init-sequence` 的命令表，不要先改时序。
7. **控件编号不固定**：`tinymix` / sysfs 控件号随驱动版本变化，按 `tinymix contents` 实际输出操作。
8. **芯片侧能力要先确认**：RSSI 这类指标依赖已建立的连接与芯片/固件支持，先看 `hcitool cmd 0x04 0x0001` 特性掩码。
9. **现象异常先怀疑烧录**：平台名、烧录路径、烧录工具都可能出错，版本不一致会制造大量假象。
10. **编译前确认分支与 xml，提交前确认远程分支名**；跨版本同步时注意补丁是否完整带入。
