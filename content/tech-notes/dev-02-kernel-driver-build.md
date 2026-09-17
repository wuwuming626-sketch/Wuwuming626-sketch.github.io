+++
title = '开发环境-02 内核驱动与构建'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 7
+++

我在 BK7258 与 RK3506 两套 SDK 间来回切，常遇到「改了代码但内核里没有这个驱动」的情况，也在容器里被 CMake 版本过低卡住过构建。下面把编译、驱动集成和调试记录完整记一遍。

> 面向平台与构建：BK7258（Armino SMP）与 RK3506 / RK3576 BSP 两个平台的 SDK 组成、编译脚本与机型开关、把驱动编译进内核的方法、字符设备与 GPIO 点灯实验、设备树/内核配置、构建产物与命令捷径，以及过程中积累的调试记录。
> 文中命令均已脱敏：内网地址、账号、个人目录一律写成示例值，品牌词统一为 `vendor` / 厂商 / 本司。

## 概述

平台侧日常打交道的是三件事：**代码怎么拉**（repo / git 多仓）、**固件怎么编**（脚本 + 机型/产品宏开关）、**驱动怎么进内核**（Kconfig + Makefile + defconfig）。三件事的载体都是 SDK 目录本身，因此先把目录与仓库组成看清楚，再谈流程。

本文覆盖：

- BK7258：Armino 自带构建系统，`projects/` 下的工程即构建目标；支持 board 与 qemu 两种 target，按 AP/CP 双核拆分构建。
- RK3506 / RK3576：`build.sh` 统一入口，按 `-t kernel / firmware / app / pkg / packet` 分阶段构建，内核驱动按 Linux 标准三件套（源文件 + Kconfig + Makefile + defconfig）集成。
- 调试记录部分按「问题现象 → 定位手段 → 根因 → 修改 → 验证结果」组织，不收录未经证实的内容。

## SDK 结构与工具链

### BK7258（Armino SMP）SDK

Armino SMP 自带一套构建系统，SDK 目录下 `projects/` 中的每个子目录就是一个可构建目标；同一工程又分为 AP（应用核）与 CP（通信核）两个镜像，可以一起编，也可以单独编。

关键路径：

- `projects/<name>/`：工程本体，含 `ap/`、`cp/` 两个子目录。
- `projects/<name>/ap/config/bk7258_ap/config`：AP 侧配置项（宏开关）落点之一。
- `projects/<name>/partitions/bk7258/ram_regions.csv`：内存分区/预存空间配置。
- `projects/qemu_voip/scripts/voip_sdkconfig_target.sh`：board / qemu 两种 target 的配置切换脚本。
- `tools/env_tools/setup/armino_env_setup.sh`：Linux 下一键安装编译环境。
- `tools/qemu/`：qemu 二进制与 bk7258 机型补丁。
- 构建产物默认落在 `build/bk7258/<project>/` 下。

### 多仓结构与代码同步

代码由内网 Gerrit/GitLab 与 repo 工具管理，`manifests` 仓库决定各子仓的版本组合：

```bash
# 厂商原始 SDK（内网 Git 服务器示例）
git clone -b release/v3.1.1 http://git.example.com/beken/bk_avdk_smp.git

# repo 方式（bk7258 组合）
repo init -u git@git.example.com:team/manifests.git \
    -b master \
    -m bk7258.xml \
    --repo-url=https://mirrors.nju.edu.cn/git/git-repo
repo sync -c --no-tags -j12 --force-sync
```

RK3506 侧同样是 manifests 组合，并可用本地 mirror 加速：

```bash
repo init --repo-url=ssh://git@git.example.com/tools/repo-mir.git \
    -u git@git.example.com:team/manifests.git \
    -b rk3506g -m rk3506g_dev_cicd.xml \
    --reference=~/work/mirrors/rk3506-gerrit-mirror-py3
# 切组合只需换 -m
repo init -m rk3506g_i503x_cicd.xml
```

同步前后常用的清理/确认动作：

```bash
repo forall -c "git status"
repo forall -c "git checkout ." && repo forall -c "git clean -df"
# 不要提交时误带 hooks
repo forall -c "rm -rf .git/hooks"
```

构建服务器上可直接用封装好的脚本完成初始化+同步，例如 `run_repo_init_sync bk7258`。

### 编译环境

**Windows**：厂商提供 Armino Bash 安装包，安装路径不能带中文；装完桌面会生成 Armino Bash 图标，双击即进入终端。

**Linux / WSL**：要求 Ubuntu 20.04 LTS 及以上、CentOS 7 及以上、Archlinux 或 Debian 11 及以上，实测 WSL 可用。SDK 内自带安装脚本：

```bash
cd $your_sdk_path
sudo bash tools/env_tools/setup/armino_env_setup.sh
```

**Docker（服务器统一环境）**：从厂商下载站取 armino-idk 镜像，加载后常驻启动，再以当前用户身份进入容器编译。

```bash
docker load -i bekencorp-armino-idk-v1.2.tar

docker run -d --name beken --restart=unless-stopped \
  -v /work:/work \
  -v /etc/localtime:/etc/localtime:ro \
  -v /etc/passwd:/etc/passwd -v /etc/group:/etc/group \
  bekencorp/armino-idk:1.2 tail -f /dev/null

# 以当前 uid/gid 进入，避免产物属主变成 root
docker exec -u $(id -u):$(id -g) -it beken /bin/bash
```

RK3506 侧容器名为 `rk3506-builder`，进入方式一致：

```bash
docker exec -u $(id -u):$(id -g) -it rk3506-builder /bin/bash
```

### RK3506 / RK3576 BSP 结构

- `bsp/kernel/drivers/char/`：字符设备驱动落点。
- `bsp/kernel/arch/arm/configs/`：内核 defconfig 所在目录。
- `bsp/kernel/include/dt-bindings/pinctrl/`：pinctrl/GPIO 相关宏定义头文件。
- BSP 根目录 `build.sh`：编译唯一入口，`-p` 指定产品、`-t` 指定构建阶段。

## 技术流程（编译/驱动/设备树/工具）

### BK7258 构建命令与机型开关

基本构建命令：

```bash
make bk7258 PROJECT=app_ab   # 构建指定工程
make bk7258                  # 不指定 PROJECT，默认构建 app
make bk7258_ap               # 只编 AP（应用处理器）
make bk7258_cp               # 只编 CP（通信处理器）
```

board / qemu 两种 target 通过配置脚本切换，再由 `TARGET` 区分：

```bash
# board：编译烧到板子上运行的代码；qemu：编译 qemu 可运行的代码
./projects/qemu_voip/scripts/voip_sdkconfig_target.sh board
make bk7258 PROJECT=qemu_voip PRODUCT=H2E
```

常用工程与产品相关变量：

| 变量 | 作用 |
| --- | --- |
| `PROJECT` | 构建哪个工程，如 `app_ab`、`qemu_voip`、`ip_cam`、`lvgl`、`video_player_example`、`uvc_example`、`player_service_example` |
| `PRODUCT` | 机型，如 `H2E`、`V50E`、`V60E`、`J600P-V2`、`MB12-V2`、`PA1`、`RM08`、`i602` |
| `TARGET` | `board` / `qemu`（不写时按工程默认，qemu 场景需显式 `TARGET=board`） |
| `VERSION` / `BUILD_VERSION` | 版本号与调试标记，如 `VERSION=T0.0.1 BUILD_VERSION=debug` |
| `PRODUCT_VSOT_SUPPORT` | 产品特性开关，MB12-V2 / PA1 等机型编译时带上 |

带版本号的完整编译示例：

```bash
make clean && make bk7258 PROJECT=qemu_voip PRODUCT=H2E       VERSION=T0.0.1
make clean && make bk7258 PROJECT=qemu_voip PRODUCT=V50E      VERSION=0.1.0
make clean && make bk7258 PROJECT=qemu_voip PRODUCT=MB12-V2 TARGET=board \
     PRODUCT_VSOT_SUPPORT=1 VERSION=T0.0.1 BUILD_VERSION=debug
# 在编译机上可以直接代理执行
dexec beken "make clean && make bk7258 PROJECT=qemu_voip PRODUCT=PA1 PRODUCT_VSOT_SUPPORT=1 VERSION=T0.0.1"
```

### 多机型批量编译脚本

批量脚本位于 BK_ATE 仓库（示例路径 `~/work/bk_ate`），本机需能执行 `dexec beken`：

```bash
cd ~/work/bk_ate
./tools/build_all_qemu_voip_products.sh                    # 全量，默认失败即停
./tools/build_all_qemu_voip_products.sh --only PA1,H2E     # 只编指定机型
./tools/build_all_qemu_voip_products.sh --keep-going       # 失败后继续
./tools/build_all_qemu_voip_products.sh --help
```

- 机型顺序：H2E → V50E → V50G-V2 → J500P-V3 → X301P-V4 → V60E → V60G-V2 → J600P-V2 → X303P-V4 → MB12-V2 → SG02(RM08) → PA1，共 12 款。
- 每款执行 `make clean && make bk7258 … VERSION=T0.0.1`；SG02 可以写 `SG02` 或 `RM08`。
- 产物目录：`tools/build_all_qemu_voip_products.out/<时间戳>/`，内含 `summary.txt`、各机型 `.log`，成功机型还有 `<sku>/all-app.bin`。
- 单款约 5–15 分钟，全量耗时较长，中途不要 Ctrl+C。

### qemu 编译与运行

编译 qemu 侧镜像：

```bash
# 参数为 board 编板子代码，为 qemu 编 qemu 代码
./projects/qemu_voip/scripts/voip_sdkconfig_target.sh qemu
```

运行：

```bash
sudo tools/qemu/qemu-system-arm \
  -M bk7258,cp-firmware=build/bk7258/qemu_voip/bk7258/app.elf,\
flash-file=qemu_flash.bin,qspi1-file=build/bk7258/qemu_voip/bk7258_ap/app.bin \
  -serial null -serial mon:stdio -display none \
  -semihosting-config enable=on,target=native \
  -kernel build/bk7258/qemu_voip/bk7258_ap/app.elf \
  -nic tap,ifname=tap0,script=no,downscript=no,model=bk7258-enet
```

- 未开 `CONFIG_PSRAM_AS_EXECUTE_MEMORY=y` 时可以不指定 `qspi1-file`，指定了也不会报错。
- WSL 下跑 qemu 要用 user 模式网卡：`-nic user,model=bk7258-enet`。
- 退出方式：在另一个终端 kill 掉 qemu 进程。

qemu 本体（带 bk7258 机型支持）自行编译：

```bash
git clone --depth 1 --branch v9.2.4 https://github.com/qemu/qemu.git && cd qemu
git am /path/to/bk_avdk_smp/tools/qemu/patches/*.patch
mkdir build && cd build
../configure --target-list=arm-softmmu
make -j"$(nproc)"
cp qemu-system-arm /path/to/bk_avdk_smp/tools/qemu/qemu-system-arm
```

### 将驱动编译进内核（RK3506）

标准 Linux 内核模块静态链接（编进内核，而非 `.ko`）流程：

1. 在 `bsp/kernel/drivers/char/` 下添加自己的驱动源文件（`.c`）。
2. 修改该目录的 `Kconfig`，新增对应的配置项（`config XXX_DRIVER` / `default n` / 依赖描述）。
3. 编写/修改该目录的 `Makefile`，按配置项条件编译：`obj-$(CONFIG_XXX_DRIVER) += xxx_driver.o`。
4. 在 `bsp/kernel/arch/arm/configs/` 下找到目标 defconfig，加入对应宏定义（如 `CONFIG_XXX_DRIVER=y`）。
5. 进入编译容器：`docker exec -u $(id -u):$(id -g) -it rk3506-builder /bin/bash`。
6. 在 BSP 根目录执行内核阶段编译：
   ```bash
   ./build.sh -p w620w -t kernel -u vendor -v T0.0.1
   ```
7. 验证：`drivers/char/` 下看到新生成的 `.o` 文件即编译成功；或查看 `kernel/.config` 中该 `CONFIG_XXX_DRIVER=y` 是否生效。

要点：驱动编进内核的前提是 **Kconfig 有项 + Makefile 有规则 + defconfig 打开**，三者缺一都会出现「改了代码但内核里没有该驱动」的现象。

### 字符设备与 GPIO 点灯实验

**GPIO 分组与编号**。RK3506 的 GPIO 按 bank + 组 + 序号组织，可查 pin 表：

- GPIO0：A0~A7、B0~B7、C0~C7、D0
- GPIO1：A0~A7、B0~B7、C0~C7、D0~D3
- GPIO2：A0~A5、B0~B7、C0
- GPIO3：A0~A7、B0~B6
- GPIO4：A0~A5、B0~B3

电气属性上，GPIO 可配置为 3.3V 或 1.8V 电平，编程时高电平写 1、低电平写 0；具体按原理图确认该引脚所在电源域。

引脚编号计算公式：`pin = bank*32 + (group*8 + index)`。例如点灯用的绿灯（`GPIO0_A7`）与红灯（`GPIO0_D0`）：

- `GPIO0_A7` → `0*32 + (0*8 + 7) = 7`
- `GPIO0_D0` → `0*32 + (3*8 + 0) = 24`

`include/dt-bindings/pinctrl/` 下的头文件中也有对应的宏定义，可直接引用而不用手算编号。

**sysfs 控制 GPIO**（应用层必须先放开该引脚，否则引脚被占用无法控制）：

```bash
# export 把 GPIO 控制权从内核空间导出到用户空间，unexport 反之
echo 24 > /sys/class/gpio/export
# gpio24 下有两个属性：direction（方向）与 value（值）
echo out > /sys/class/gpio/gpio24/direction
# 写 1 点亮
echo 1 > /sys/class/gpio/gpio24/value
# 读当前值
cat /sys/class/gpio/gpio24/value
```

BK7258 侧不经过 sysfs，而是通过固化在固件里的命令行直接操作 GPIO（见 3.7）。

### 设备树与内核配置查询

- 内核侧 defconfig：`bsp/kernel/arch/arm/configs/<target>_defconfig`，改完需重新跑内核阶段构建。
- 生成配置验证：`bsp/kernel/.config` 中查 `CONFIG_*` 是否落到 `=y`。
- 运行态设备树查询（板端）：

```bash
cat /proc/device-tree/__symbols__/sai4 && echo "sai4"
ls -la /proc/device-tree/sai@2a640000/
cat /proc/device-tree/sai@2a640000/rockchip,sai-rx-wait-time-ms 2>/dev/null
```

- BK7258 侧的功能宏开关以工程配置文件形式存在，例如统计 CPU 占用率需要在 AP 配置里打开：

```text
projects/ip_cam/ap/config/bk7258_ap/config
CONFIG_FREERTOS_HISTORY_CPU_PERCENT=y
```

- 内存分区/预留：`projects/ip_cam/partitions/bk7258/ram_regions.csv`（编解码预留空间等在此调整）。
- Android 侧内核单独编译走 defconfig + 镜像目标，例如：

```bash
cd kernel && make distclean
make ARCH=arm64 v67_defconfig
make ARCH=arm64 px30-evb-ddr3-v10-avb-v67.img -j8
```

### 构建产物与命令捷径

- BK7258：`build/bk7258/<project>/` 下为 AP/CP 镜像，整包产物为 `all-app.bin`（批量脚本会把每个 SKU 的 `all-app.bin` 收集到输出目录）。
- RK3506 / Android 侧分阶段构建入口：

```bash
./build.sh -p w620w -t all -u vendor -v T0.0.1
./build.sh -p w620w -t kernel -u vendor -v T0.0.1
./build.sh -p w620w -t firmware
./build.sh -p w620w -t app
./build.sh -p w620w -t pkg-only x_app        # 只打包某模块
./build.sh -p w620w -t packet --withadb
./full_build.sh -p A330 -c vendor            # Android 整包
./vendor/vendor/build/tools/compile.sh -p A330 -C vendor -ak   # 只编 kernel
```

- 板端常用交互（BK7258 固件命令）：

```bash
ap_cmd gpio output 24            # 配成输出
ap_cmd gpio output_high 24       # 拉高
ap_cmd gpio output_low 24        # 拉低
ap_cmd gpio input_get 21         # 读输入
ap_cmd gpio_map devs 24 0
ap_cmd mem_stat                  # 内存统计
ap_cmd cpuload / tasklist / osinfo / memstack
ap_cmd log 1 4 0 1 ; ap_cmd modlog usb_dpdn on
ap_cmd ls /mnt/udisk             # U 盘挂载点
```

- 编译机上的 `dexec <容器>` 是容器内执行命令的快捷方式，例如 `dexec beken make bk7258 PROJECT=ip_cam`。

## 问题与调试记录

### 容器内 CMake 版本过低导致构建配置失败

- **现象**：按流程进入容器执行 `make bk7258 PROJECT=video_player_example` / `uvc_example` 报错退出。
- **定位手段**：读报错栈，指向 SDK 组件 `vcore` 的构建配置阶段；容器内 `cmake --version` 为 3.16.3。
- **根因**：`vcore` 要求 CMake ≥ 3.18，容器自带版本不满足。
- **修改**：以 root 进入容器升级 CMake（普通用户无权安装）。
  ```bash
  docker exec -u 0 -it beken /bin/bash
  pip3 install --upgrade pip
  pip3 install "cmake>=3.18"     # 无 pip3 时先 apt install -y python3-pip
  cmake --version                # 确认版本已更新
  ```
- **验证**：切回普通用户 `docker exec -u $(id -u):$(id -g) -it beken /bin/bash`，重新 `make bk7258 PROJECT=uvc_example` 编译通过。

### 无复位键时烧录握手失败

- **现象**：板子没有复位键，用「重新上电」代替复位，BKFIL 烧录仍失败。
- **定位手段**：观察工具日志，长时间停留在握手阶段，未出现 `Getting Bus...` / `LinkCheck...` 之后的进展。
- **根因**：烧录工具与芯片的握手窗口很短（几十毫秒级），上电时机与工具等待窗口没对上——先上电时芯片已直接启动，错过烧录窗口。
- **修改**：严格按规定时序操作——先断开发板电源，在工具里配好 `all-app.bin` 与串口后点击 Download；待日志出现 `Getting Bus...` 或 `LinkCheck...`（工具已进入等待态）后 **1 秒内**给板子接上 5V/2A 电源。
- **验证**：上电瞬间芯片短暂进入 BOOT 模式，工具成功捕获并完成烧录。

### `ap_cmd ostop` 统计 CPU 占用导致系统崩溃

- **现象**：用 `ap_cmd ostop` 统计 DVP 推流时的 CPU 占用率，命令直接把系统打崩（总线异常 / HardFault）。
- **定位手段**：复现 + 分析该命令强制开启的内核统计逻辑。
- **根因**：`ostop` 开启的内核统计会并发遍历任务链表，存在内存读写竞态，最终触发总线异常。
- **修改**：放弃 `ostop`，改用硬件定时器中断采样统计 CPU 占用：定时器（如 500ms）触发中断 → 中断回调中取当前正在运行的任务名 → 统计各任务被采样次数 → 换算占用率。
  ```bash
  ap_cmd cpu_prof init 40      # 采样间隔 500ms
  ap_cmd cpu_prof start
  # 运行 DVP 推流 10~30s
  ap_cmd cpu_prof show
  ap_cmd cpu_prof stop
  ```
- **验证**：采样期间系统稳定，可拿到各任务占用率；配合 `ap_cmd mem_stat`、`ap_cmd dump_encode_heap` 一起看资源。

### UVC MJPEG 流串口狂报 JPEG 解析错误

- **现象**：串口持续打印 `unexpected jpeg typecode 0xe1`、`error can't find quant table 1`、`malformed jpeg`，但 VLC 拉流画面正常。
- **定位手段**：日志逐级对应解析流程，定位到 RTP 封包前的 `rp.c`/`rtp.c` 中 `findJPEGheader`（RTP 封包前的预处理：扫描 MJPEG 裸流、剔除 APP 标记段、提取量化表与霍夫曼表）。
- **根因**：摄像头的 MJPEG 流不是纯 JPEG，JPEG 数据前夹带 EXIF 信息头（标记码 `0xE1`）。原逻辑只处理了 `0xe0`（JFIF），缺少 `0xe1` 分支，导致跳到 default 报错，并因跳过了该段而丢失后续量化表。解码器选择本身没错（MJPEG / `V4L2_PIX_FMT_MJPEG`），出问题的是数据头解析器；VLC 的 FFmpeg 解码库对未知标记非常宽容，会自动跳过，所以画面正常。
- **修改**：在标记分支中增加 `case 0xe1:`，与 JFIF 头一样直接跳过该段数据。
  ```c
  switch (marker) {
      case 0xe0: /* JFIF 头，跳过 */
          break;
      case 0xe1: /* EXIF(APP1)，跳过，避免污染后续量化表解析 */
          break;
      default:
          printf("unexpected jpeg typecode 0x%02x\n", marker);
  }
  ```
- **验证**：重新编译烧录后串口错误消失、画面依旧正常。若出现局部花屏/绿条，说明 EXIF 段过长跳过了过多数据，需要再收紧跳过逻辑。

### AVI1 格式 MJPEG 的量化表提取失败

- **现象**：修掉 `0xe1` 后仍有 `malformed jpeg, framing=43`（0x43 即字符 'C'），VLC 播放正常。
- **定位手段**：抓 JPEG 数据头 `ff d8 ff e0 00 21 41 56 49 31 00 01 01 01 00 78`，逐字段解析。
- **根因**：`ff d8` 为 SOI、`ff e0` 为 APP0、长度字段 `00 21` = 33 字节，但其标识是 ASCII `"AVI1"` 而非标准 `"JFIF"`。此类摄像头使用的是 AVI1 形式 MJPEG，RTP 封装前的 `decodeJPEGfile` 按 JFIF 结构解析，取不到量化表；而 VLC 因为协议/解码器有 fallback 机制，数据本身完整所以能正常播放。
- **修改/结论**：问题不在 JPEG 数据本身，而在封装前的解析函数对 AVI1 的兼容性，需要按同样思路扩展 APP0 内容判断（区分 `JFIF` 与 `AVI1`），而不是改解码器或换格式。

### qemu 运行环境相关

- **现象**：WSL 里按默认命令跑 qemu 时网络不通。
- **定位手段**：对比 board/裸机环境的网卡参数。
- **根因**：默认使用 tap 网卡（`-nic tap,ifname=tap0`），WSL 下不可用。
- **修改**：改为 `-nic user,model=bk7258-enet`。
- **验证**：qemu 内网络可用。
- **附带结论**：未开 `CONFIG_PSRAM_AS_EXECUTE_MEMORY=y` 时，`qspi1-file` 参数可省，指定也不报错；退出 qemu 需在另一终端 kill 进程。

### 推流场景的资源占用与延迟观察

- **现象**：IP Cam / DVP 推流下，VLC 起播 1–2 秒延迟，运行几分钟后延迟涨到约 10s；720p 时 CPU 占用明显上升。
- **定位手段**：`ap_cmd mem_stat`、`ap_cmd dump_encode_heap`、`ap_cmd cpu_prof`，未拉流 / 拉流中两种状态分别采样。

| 分辨率 | 状态 | SRAM 剩余 | PSRAM 剩余 | ENCODE 预留 | ENCODE 实际 | CPU 占用 |
| --- | --- | --- | --- | --- | --- | --- |
| 640×480 | 未拉流 | 174.07 KB | 617.66 KB | 1400 KB | 717.6 KB（6 块） | 0% |
| 640×480 | 拉流中 | 170.10 KB | 609.20 KB | 1400 KB | 119.6 KB（1 块） | 2.23% |
| 1280×720 | 未拉流 | 134.07 KB | 617.66 KB | 1400 KB | 717.6 KB（6 块） | 0% |
| 1280×720 | 拉流中 | 130.03 KB | 609.20 KB | 1400 KB | 119.6 KB（1 块） | 7.65% |

  另一组采样（`mem_stat` 输出）：SRAM 堆 336 KB/峰值 216.86 KB（64.5%）、PSRAM SLAB 7.00 MB（100%）、PSRAM 堆 640 KB/30.80 KB（4.8%）、PSRAM 总计 7.63 MB（92.2%）。

- **根因/结论**：PSRAM 层（SLAB）已 100% 占用，是主要瓶颈；编解码预留 1.37 MB 在拉流时实际只用了一块，剩余可作调整空间；延迟随运行时间增长指向缓冲/线程处理能力。
- **调整方向**：按 `partitions/bk7258/ram_regions.csv` 调整预存空间；增加 RTP 线程栈大小（`projects/ip_cam/ap/components/rtsp_rtp/rtp/rtp.c`）；统计用 `ap_cmd cpu_prof` 取代会崩的 `ostop`。

## 常用命令与脚本速查

**代码同步 / 提交**

```bash
repo sync -c --no-tags -j12 --force-sync
repo forall -c "git checkout ." && repo forall -c "git clean -df"

git commit -m "[T104526] [BUG] [W61x] [BT]: 修复长按耳机键切换声音通道失败"
git push fv HEAD:refs/for/master
git push fv HEAD:refs/for/rk3506g_dev_cicd

# 取指定 change
git fetch fv refs/changes/33/23833/22 && git cherry-pick FETCH_HEAD
git format-patch --subject-prefix="" --no-numbered <sha>..HEAD -o ./patches
git am -k ./patches/*
git apply --reject ./patches/0001-xxx.patch    # 冲突时产生 .rej
```

**容器内执行 / 编译入口**

```bash
docker exec -u $(id -u):$(id -g) -it beken /bin/bash
dexec beken "make clean && make bk7258 PROJECT=ip_cam"
./build.sh -p w620w -t kernel -u vendor -v T0.0.1
./build.sh -p w610h -u vendor -t all
```

**板端/设备端**

```bash
adb root && adb remount
adb push xxx.ko /vendor/lib/modules/
adb pull /tmp/btsnoop_hci.log ./
adb shell logcat -v time > logcat_with_time.txt
adb push ./FactoryTest /system/priv-app/
```

**内核/设备树排查**

```bash
grep -rnw mixer_open_legacy --exclude-dir=out --exclude-dir=rockdev -I
ls -l /proc/<pid>/fd | grep "/dev/snd/"
cat /proc/device-tree/__symbols__/<node>
```

## 注意事项

1. **改驱动的三件套必须齐**：源文件、Kconfig、Makefile 只写一半，或 defconfig 未打开，都会表现为「编译通过但内核里没有驱动」；改完用 `.config` 与 `.o` 双向确认。
2. **编译前先确认 `PROJECT` / `PRODUCT` / `TARGET`**：同一个 SDK 下工程众多，选错工程或漏 `TARGET=board` 会编出用途不符的镜像；批量编译脚本不要中途 Ctrl+C。
3. **容器内以当前用户身份进入**（`-u $(id -u):$(id -g)`），需要装包时才临时用 root，避免产物属主变成 root。
4. **不要把 `.git/hooks` 带进仓库**，提交前用 `repo forall -c "rm -rf .git/hooks"` 清理，并确认 commit-msg hook 已就位。
5. **烧录依赖上电时序**，无复位键的板子先让工具进入等待态再上电；板子 IP/服务器 IP 等环境变量用 `setenv … saveenv` 固化后注意别残留。
6. **内存是最先耗尽的资源**：PSRAM SLAB 打满后各种延迟/丢帧现象会连锁出现，先看 `mem_stat` / `dump_encode_heap` 再谈优化。
7. **Android 整包**：拉取代码前确认 `~/version` 目录与打包密钥文件已就位，否则版本与签名环节会中断。
