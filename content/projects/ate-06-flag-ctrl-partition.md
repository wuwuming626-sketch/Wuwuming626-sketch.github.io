+++
title = 'ATE-06 产测标志位与 ctrl 分区'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 6
+++

一台已经产测通过的 V60E，重烧一次 all-app.bin 之后，居然又乖乖回到了 ATE 模式。翻来查去，元凶是 clean meta——它顺着打包链路一路写穿了 ctrl 分区，把 ATE_DONE 位硬生生打回了 0。下面是这桩「产测记忆错乱」的完整定位与验证过程。

> 范围：BK7258 话机 SKU（`sdk-repo` / `voip-project`）打包链路与运行态产测标志
> 机型：V60E / V60P-V2（真机验证），H2E / H2U 等（硬件版本识别）
> 素材：6 份设计稿 / 任务报告 / 前后对照 / 方案对比文档

---

## 概述

`ctrl` 是 Flash 尾部的一个 8K 分区，只存一个 8 字节控制块（`magic(4) + packed_meta(4)`），
它是固件的**运行态状态存储**（启动标志、OTA pending、OTA 结果、OTA URL），不是固件镜像的组成部分。
但历史打包链路把出厂 clean meta（`magic=CTRL`、`boot_flag=0`）合并进了 `all-app.bin`，带来两个问题：
① 重烧日常 `all-app.bin` 会写穿 ctrl，把板上已产测写入的 `ATE_DONE`（`boot_flag` bit2）打回 0，
无按键冷启动又走产测 ATE 路径；② 出厂镜像是否含 ctrl、含什么内容，取决于打包工具链而非固件约定。

本次落地方案为「**all-app 不再打包 ctrl + 镜像长度截断到已打包分区终点**」，
保留 `auto_partitions.csv` 的 ctrl 分区行，由固件既有的「magic 无效 → 降级为 clean 零值」机制兜底。
另一条备选路径（方案 A：把 ctrl 并入 32KB `sysnet.bin` 工厂尾镜像）只到设计稿，未落地。

核心结论：

| 项 | 移除前 | 落地后（删 manifest 条目 + 截断） |
|----|--------|-----------------------------------|
| `all-app.bin` 是否含 ctrl 业务内容 | 含（8B clean meta） | 不含 |
| `all-app.bin` 是否写到 ctrl 地址 | 是（写 clean） | 否（停在 `0x7F8000`） |
| `all-app.bin` 长度 | 8355904（`0x7F8040`） | **8355840（`0x7F8000`）**，Δ = −64 |
| Flash 分区表 ctrl 行 | 有 | **保留** |
| `sysnet.bin` | 328B PID 补丁 @ `0x7FF000` | 不变 |
| 新机首次开机 | 进 ATE | 进 ATE（行为等价） |
| `ATE_DONE=1` 后不擦除重烧 `all-app` | 被盖回 0，又进 ATE | 保留，正常启动 |

---

## 数据结构与分区布局

### Flash 尾部布局（8MB，分区表未改）

```
0x7F8000  ctrl          8K    ← 运行态状态区；落地后镜像不再写入
0x7FA000  easyflash     8K
0x7FC000  easyflash_ap  8K
0x7FE000  sys_rf        4K
0x7FF000  sys_net       4K    ← sysnet.bin 仍烧此处（PID / GroupID 补丁）
0x800000  Flash 顶（约 8MB）
```

变的是「哪些文件覆盖哪些地址」，不是分区怎么划。**ctrl 起点 `0x7F8000` 到 Flash 顶恰好 32KB**，
这一尺寸关系正是方案 A 能把整条工厂尾链塞进单个 32KB 文件的前提。

### 进入 `all-app.bin` 的 6 个连续分区

`auto_partitions.csv` 中进入日常打包的连续区间（不含 ctrl / easyflash / sys_*）：

| 分区 | CSV Size | 字节 | 起点 | 终点 |
|------|----------|------|------|------|
| primary_bootloader | 68k | 69632 | `0x0` | `0x11000` |
| primary_cp_app | 952k | 974848 | `0x11000` | `0xFF000` |
| primary_post | 700k | 716800 | `0xFF000` | `0x1AE000` |
| ota | 4336k | 4440064 | `0x1AE000` | `0x5EA000` |
| logo | 64k | 65536 | `0x5EA000` | `0x5FA000` |
| userdata | 2040k | 2088960 | `0x5FA000` | **`0x7F8000`** |

累加终点 = 8355840 = **`0x7F8000`** = ctrl 分区起点。线性 linker 写完这 6 项后文件长度**本应**正好是这个值，
这是后面定位「多出 64 字节」的关键基准。

### ctrl 控制块格式与标志位语义

- 出厂 / 打包曾写入的内容：仅 **8 字节**
  - `magic` = 小端 `"CTRL"`（文件字节序 `4c 52 54 43`，按小端读出为 `0x4354524C`）
  - `meta` 全 0（含 `boot_flag=0`）
  - 俗称 **clean meta**：不是「完全空白」，而是「合法但干净」的快照。
- 运行时才更新的内容（由固件 `fv_bk_ota_ctrl` 写入）：
  - `boot_flag`（含 **`ATE_DONE` = bit2**、Recovery、ATE 重连等位）
  - `pending_target` / `ota_result`
  - 第二扇区存放的 OTA URL 等
- **`ATE_DONE` 的物理位置是 Flash ctrl 分区的 `boot_flag` bit2**，不是 AP/CP 固件里的代码常量；
  要变成 1，必须由产测等逻辑调用 `fv_bk_ota_ctrl_set_ate_done(1)` 往板上真写一次。
- 位定义集中在 `fv_bk_ota_ctrl.h`；本次只展开 bit2 与 ATE 相关语义，其余位不逐位推测。

### 镜像尾部 64 字节填充的成因

启用带 CRC 的打包器后，拼完分区还会往文件尾追加两段全 `0xFF`：

```text
步骤                          长度(hex)     说明
─────────────────────────────────────────────────────────
线性打包写完 6 区              0x7F8000     本应停在这里
+ 34 字节 0xFF                 0x7F8022     第 1 段填充（CRC 收尾包装）
+ 30 字节 0xFF                 0x7F8040     第 2 段填充（32 字节对齐）
```

- 第 1 段来自 `bk_packager_crc_decorator.py` 的 `post_link` 包装，固定追加 **34** 字节 `0xFF`；
  带 CRC 那套打包器的收尾函数体本身常是空的 `pass`，真正写 34 的是套在它外面的包装函数。
- 第 2 段来自 `bk_build_package.py` 的 `binary_align_32_byte`：

  ```python
  padding_size = (32 - bin_size % 32) % 32    # 本布局算出 30
  f.write(bytes([0xFF] * padding_size))
  ```

  验算：`0x7F8022 ÷ 32` 余 2 → 还差 `32 − 2 = 30`。
- 两段合计 **34 + 30 = 64** → 最终长度 `0x7F8040`（8355904）。
- 与 CRC 本身要区分：**代码类分区**的校验格式是「32 字节数据 + 2 字节 CRC16 = 一块 34 字节」，膨胀是每块 +2 且校验码是算出来的；
  末尾那 34 字节只是把「一整块 34」当缓冲垫再追加一次，**不是校验结果**，也不是整份 all-app 的总校验。
  userdata / logo 这类数据区默认不插 CRC。
- `0x7F8000` 本身已能被 32 整除：若不先垫这 34，就不需要再补 30，文件会正好停在 ctrl 门口。
  这 64 字节无业务数据、对产品几乎无用，却会烧进 Flash 盖住 ctrl 开头。

---

## 技术流程

### ctrl 进入固件镜像的完整链路（打包侧现状）

1. `auto_partitions.csv` 含 ctrl 行（8K、data 类型）→ 生成 `partitions.json` 的 ctrl section。
2. `bk_sdk_project.py` 的 `pre_package()` 依次调用：
   - `gen_ctrl_partition_bin()`（`bk_ctrl_partition_gen.py`）：运行预置工具生成 8 字节 `partitions/ctrl.bin`；
   - `merge_fs_pack_into_bk_package()`（`bk_fs_image_pack.py`）：遍历 `fs_pack_manifest.json`，
     把 `fstype=raw` 的条目（即 ctrl）合并进 `bk_package.json`。
3. `bk_flash_partition.gen_pack_json()` **默认不打包 data 分区**；
   所以 ctrl 能进镜像的**唯一入口**就是 `fs_pack_manifest.json` 里的 ctrl 条目。
4. `bk_packager.pack()` 按 `bk_package.json` 生成线性 `all-app.bin`。

关键推论：**删掉 `fs_pack_manifest.json` 的 ctrl 条目即切断其进入固件的唯一通道**，无需改固件代码。

### 开机探测与分支（运行态）

固件读到 ctrl 区的两种情形，最终都收敛到同一份零值视图：

| 情形 | 处理 |
|------|------|
| 旧出厂 clean meta | `magic = CTRL`，`meta` 全 0 → `boot_flag = 0` |
| 空板 / 擦除态全 `0xFF` | `parse_raw` 检出 `magic != 0x4354524C` → 结构体清零；`normalize_in_memory` 再清零 → 返回 `BK_OK` |

即「读到全 `0xFF`」不是另有一套默认变量，而是**按 clean 零值处理**，与旧 clean meta 在 `boot_flag` 上逐位等价。
`boot_flag=0` → `ATE_DONE(bit2)=0` → 按头文件语义「默认进厂商 ATE 产测」。

空 ctrl 冷启动 / 已产测设备的分支实测日志（已脱敏）：

```
# 空 ctrl（magic 无效 → 降级 clean）
cp_boot: boot Post (APPLICATION2)
fv_bk_ot: read raw: ff ff ff ff ff ff ff ff => magic=0x00000000 boot=0
=== [Recovery] Jumping to AP at 0x60300000 ===
boot probe: ATE_DONE=0, default Vendor ATE factory path
OS: create bk_ate

# 已产测
ATE_DONE=1, default normal boot
create xui_main
```

magic 无效时的各调用方分支（均为安全分支）：

| 调用路径 | 无效 magic 下的行为 |
|----------|---------------------|
| `fv_ota_post_is_available()` | 返回 true，Post 可用，正常启动 |
| `fv_cp_boot_should_jump_ap()` | 正常跳 AP，且不写 Flash |
| `fv_bk_ota_ctrl_is_ota_abnormal()` | `ota_result=0` → false，不触发 failover |
| `fv_bk_ota_ctrl_read_url()` | 首字节 `0xFF` → 返回空串 |
| `/health` | 走默认分支，不崩 |

### 写入 / 清除路径

| 动作 | 触发者 | 结果 |
|------|--------|------|
| 置位 | 产测逻辑调用 `fv_bk_ota_ctrl_set_ate_done(1)` | `boot_flag 0x00 → 0x04`（bit2 置 1），落盘需 commit |
| 落盘 | `fv_bk_ota_ctrl_commit()` | 先擦 sector0 再写 8B |
| 清除 | 工装重工（DHCP option43 下发 `Vendor_ATE=`） | `ATE_DONE bit2 clr (0x04 → 0x00)` |
| 按键进 ATE | 用户长按 / Post stay | **不写** Flash，`boot=4` 保持 |
| OTA 状态机 | `set_cp_pending` / `set_post_ota_boot` / `set_result` | 均保留 `ATE_DONE` |
| 复位清理 | `reset_clean` | 通过 `keep_bits` 保留 `ATE_DONE \| ATE_RECONNECT` |

要点：**界面进 ATE ≠ 修改 Flash 的 bit2**；**进 Post ≠ 写 ctrl**；只有真正调用 set/commit 才落盘。

### 与 OTA 的关系

- OTA 过滤配置 `ota_pack.json` 仅 `include_apps: ["cp", "ap"]`；ctrl 是 data 分区，不在任何 include 列表，
  `.z` 包切片自 ota（COMB）分区、**不含 ctrl**，所以 OTA 不会「升级 ctrl 分区数据」；
  过程中固件主动写 ctrl（`set_pending` / `reset_clean` / `set_result`）属状态机行为，因此 OTA 全程可保留 `ATE_DONE`。
- 出厂镜像里**从来没**打包过 URL、pending、产测结果，那些本来就只存在于机器上。
- 已记录的固有风险：`commit` 的 erase → write 之间断电会让 sector0 全 `0xFF`，`magic` 与 `boot_flag` 一起丢失，
  导致 OTA 后进 ATE——这是 commit 自身的断电风险，与是否打包 ctrl 无关。

### 与工装（工厂烧录）的关系

工厂两段式烧录（本落地方案下 sysnet 侧不变）：

```
1) all-app.bin     @ 0x0
2) sysnet.bin      @ 0x7FF000     # 仅 sys_net PID / GroupID 补丁（328B）
```

- 差异只在：`all-app.bin` 是否顺带覆盖 ctrl。
- `all-app-factory.bin` = `all-app.bin` + 在 `sys_net @ 0x7FF000` 打 PID / GroupID 补丁（ctrl 窗保持 `0xFF`）。
- 工厂烧录器单文件上限为 `0x7FE000`（8MB − 8KB），`sys_net` 补丁落在 `0x7FF000`，
  故采用分次烧录规避（见问题单 #1）。
- **前提**：烧录器只擦写镜像覆盖到的扇区，不做全片擦除；若全片擦，ctrl 仍会丢，与是否打包无关。

### 备选方案 A：ctrl 移出 all-app 并并入 32KB `sysnet.bin`（仅设计，未落地）

思路：把 ctrl 与工厂尾补丁合并为一段连续尾镜像，简化「主镜像 + 尾镜像」模型。

```
FACTORY_TAIL_BASE = 0x7F8000
FACTORY_TAIL_SIZE = 0x800000 - 0x7F8000 = 0x8000 = 32 KiB
```

`sysnet.bin` 内部布局（32KB）：

| 文件内偏移 | Flash 偏移 | 大小 | 内容 |
|-----------|-----------|------|------|
| `0x0000` | `0x7F8000` | 8K | `ctrl.bin` 有效数据（8B）+ `0xFF` 填充 |
| `0x2000` | `0x7FA000` | 8K | `0xFF`（easyflash，出厂不编程 NV） |
| `0x4000` | `0x7FC000` | 8K | `0xFF`（easyflash_ap） |
| `0x6000` | `0x7FE000` | 4K | `0xFF`（sys_rf） |
| `0x7000` | `0x7FF000` | 4K | sys_net V2 头 + PID / GroupID 补丁 |

工厂烧录变为 `all-app.bin @ 0` + `sysnet.bin @ 0x7F8000`。设计稿提出的改动点：manifest 为 ctrl 增加 `merge_into_all_app: false` / `factory_tail: true`；`bk_fs_image_pack.py` 在 merge / copy 循环跳过该类条目；`bk_product_pid_pack.py` 新增分区偏移读取与 `build_factory_tail_image`，并更新 `factory_flash_segments.json`（第二段 offset `0x7f8000`、size `0x8000`）。

方案 A 的边界：只烧 `all-app-factory.bin` 不烧 `sysnet.bin` 会缺 ctrl 出厂数据；返修时重烧整段 32KB tail 可能连带擦掉 easyflash 里的用户 NV。

两条路径对比：

| 维度 | 本落地（移除打包 + 截断） | 方案 A（sysnet 尾镜像） |
|------|---------------------------|--------------------------|
| all-app 含 ctrl | 否 | 否 |
| sysnet 含 ctrl | 否 | 是（32KB，从 `0x7F8000` 起） |
| 出厂 ctrl 区 | 保持 `0xFF`，靠固件降级 | 主动烧 8B clean |
| 改动量 | 最小（manifest + 截断） | 需改 pid_pack / segments 等 |
| 主要解决 | 重烧 all-app 误清 `ATE_DONE` | 工厂一次带上 ctrl + PID |

### 与产测相关的另一条链路：硬件版本号识别（ATE vs legacy-app）

与 ctrl/ATE_DONE 无耦合，但同属产测判定的组成部分，单独记录。

| | ATE | legacy-app（代码同步后） |
|---|---|---|
| 配置来源 | 无配置文件，`bk_ate_hw_version.h` 硬编码 | `/etc/hw_ver.conf`（构建时从 `gui-repo/tools/hw_version_conf/<product>/hw_ver.conf` 模板拷入） |
| 分发方式 | `bk_ate_hw_ver_board_find(model)` 按型号查表 | 每个产品固件内置自己的 conf 文件 |
| 支持方式 / 通道 | 仅 ADC，ADC15（GPIO13 / P13） | ADC 或 GPIO（conf 指定），默认 ADC15，可覆盖 |
| 运行时入口 | `bk_ate_proto.c` | `main.c` → `hardware_ver.c` → `propGetHardwareVersion()` |

数据流：ATE 走 `bk_ate_proto.c → bk_ate_hw_ver_board_find(model) → bk_adc_read(ADC15) → 换算 mV → bk_ate_hw_ver_match_mv() → hw_ver 字符串`；
legacy-app 走 `main.c: getHardwareVersion() → hardware_ver_read()`，按 conf 的 `[ADC]` 走 `x_adc_read → x_adc_to_voltage` 范围匹配，
按 `[GPIO]` 走 `x_gpio_get_input(GPIO82/80/81)` 的 pattern 匹配，结果同时写入 `version.txt` 供 POST / RM08 读取。

阈值（mV，V50E / V60E / V50P / V60P 及 G、J、X 系列共用，ATE 与 legacy-app ADC 模式完全一致）：
V2.0 = 3010~3300，V2.1 = 2460~3009，V2.2 = 1925~2459，V2.3 = 1355~1924，V1.0 = 830~1354，V1.1 = 300~829，V1.2 = 0~299。
GPIO 模式用 GPIO82/80/81 读 3-bit 编码：V2.0 = `04`、V2.1 = `05`、V1.0 = `00`、V1.1 = `02`，
只有 4 档，**无法覆盖 V2.2 / V2.3 / V1.2**。H2E / H2U 只定义 V2.0 = 2780~3300 mV，两边一致。

遗留差异：`v60g` / `v60w` 的 GPIO conf 缺 V1.1、V2.1；`v60p` 的旧 GPIO conf 同样缺档，
但实际构建 V60(P) 用的是 `v60e` 的 ADC 配置，因此不受影响。

---

## 调试过程记录

### 现象

- 已产测（`ATE_DONE=1`）的设备，**不擦除**重烧日常 `all-app.bin` 后重新开机，又进入 ATE 界面；
  读回 ctrl 发现 `magic`/`boot_flag` 被改变。
- 同时观察到 MAC / PID 未变 → 排除「整片擦除」，指向**局部写穿（overlap）**。
- 副现象：设计稿预期删掉 ctrl 后镜像应「少 8K」，实测体积只少 64 字节，与预期不符。

### 定位手段

1. **产物字节级对照**：对 `all-app.bin` / `all-app-factory.bin` / `sysnet.bin` 做 `ls -l` + `xxd` 定点比对（重点看 `0x7F8000`、`0x7FF000` 两处）。
2. **打包清单校验**：检查 `bk_package.json` 的 `section` 数组是否仍含 `"partition": "ctrl"`，并输出各产品的 `has_ctrl` 与分区名列表。
3. **长度累加验算**：手工累加 6 个分区的 CSV size，确认终点 = `0x7F8000`，排除「分区尺寸写错」这一可能。
4. **打包侧代码走查**：沿 `pack_all_bin` 调用链找到两处追加 `0xFF` 的位置，用 `0x7F8022 % 32 = 2` 复算 30。
5. **真机日志取证**：`ate_done set 1` 前后、重启前后、不擦除重烧前后分别读 `read raw` 与 boot 分支日志；OTA 分「网页」与「ATE 工装」两条路径分别取证。

关键证据摘录（打包侧，已脱敏）：

```
# 移除前
size 8355904 (0x7f8040)
007f8000: 4c52 5443 0000 0000 ....        # CTRL + clean meta

# 仅删 manifest、未截断（中间态）
size 仍 8355904
007f8000: ffff ffff ffff ffff ....        # 仍写穿 ctrl 开头

# 删 + 截断（目标态）
size 8355840 (0x7f8000)
xxd -s 0x7F8000 all-app.bin  → 无输出（EOF）

# factory 镜像
007f8000: ffff ffff ffff ffff ....        # ctrl 窗不再写 clean meta
007ff000: 4d41 4332 ... 3330 3032 ...     # "MAC2" 头 + ASCII "3002"（PID 完好）

# 分区清单（has_ctrl）
移除前：v60e  True   HAS   bootloader, app, app2, app1, logo, userdata, ctrl
移除后：v60e  False  NO    bootloader, app, app2, app1, logo, userdata
```

（`result=NO` 表示无 ctrl，不是失败。）

### 根因

分两层，缺一不可：

1. **主因**：`fs_pack_manifest.json` 的 ctrl 条目让 8 字节 clean meta（`boot_flag=0`）进入 `all-app.bin`，
   烧录时按「文件多长就从 0 写多长」写 Flash，把板上 ctrl 的 `boot_flag` 覆盖回 0，`ATE_DONE` 被清除。
2. **隐蔽的次因**：**仅删 manifest 不够**。打包链路在 userdata 终点 `0x7F8000` 之后仍会追加
   **34（CRC `post_link`）+ 30（32 字节对齐）= 64 字节 `0xFF`**，文件长度仍为 `0x7F8040`；
   烧录时这 64 字节落在 `0x7F8000 … 0x7F803F`（ctrl 开头），照样破坏板上状态，只是内容由 clean 变成全 `FF`。
   → 因此必须补一步「**截断到已打包分区终点**」。

### 修改

最小改动集，共 3 个文件（`git diff` 相对分支 `0813`）：

| 文件 | 变更量 | 作用 |
|------|--------|------|
| `projects/voip-project/fs_pack_manifest.json` | −6 行 | 删除 ctrl 的 raw 条目，切断其进入 `all-app` 的唯一入口 |
| `tools/build_tools/build_process/bk_build_package.py` | +51 行 | 新增 `packed_sections_end()` / `truncate_bin_to_packed_end()`，在 `pack_all_bin()` 的对齐之后调用 |
| `tools/build_tools/build_process/bk_sdk/bk_sdk_project.py` | +8 行 | `post_package()` 在 `ota_pack()` 之后、生成 factory 镜像之前再截一次，防止被再次拉长 |

调用顺序（两处落点）：

```python
# ① bk_build_package.py：对齐之后立刻截断到已打包终点
binary_align_32_byte(output_bin)
truncate_bin_to_packed_end(output_bin, pack_json)

# ② bk_sdk_project.py：OTA 处理后再钳一次，防止长度被拉回
ota_bin, ota_z_bin = ota_pack()
truncate_bin_to_packed_end(package_dir / "all-app.bin", pack_json)
build_all_app_factory_image_post_package(self)
```

策略说明：**先垫后裁**——保留插入 CRC 与 32 字节对齐逻辑，最后按 `bk_package.json` 中已打包 section 的最大结束地址裁剪文件长度。
`0x7F8000` 本身已是 32 的倍数，裁完仍满足对齐。

**必须保留不动**：

- `auto_partitions.csv` 的 ctrl 分区行（删行会变成「分区不存在」，语义不同，且影响产线工具 / OTA / 内存布局）；
- `gen_ctrl_partition_bin()`（仍生成 `partitions/ctrl.bin` 供校验与将来单独烧录，只是不 merge 进镜像）；
- `sysnet`/PID 打包逻辑、烧录偏移 `0x7FF000`、固件 `fv_bk_ota_ctrl` 一律不改。

### 验证结论

打包侧（不烧板）与真机侧均以 V60E 全量包验证，镜像态 = 删 manifest ctrl + 截断到 `0x7F8000`：

| 项 | 状态 | 关键证据 |
|----|------|----------|
| 7.1-1 全量编译含 package | PASS | 产物齐全（all-app / factory / sysnet / ota） |
| 7.1-2 `bk_package.json` 无 ctrl section | PASS | `has_ctrl` 由 True/HAS 变 False/NO |
| 7.1-3 all-app 长度与无 CTRL magic | PASS | 8355904 → 8355840；`xxd -s 0x7F8000` 无输出（EOF） |
| 7.1-4 factory ctrl 窗 / PID | PASS | ctrl 窗全 `FF`；`@0x7FF000` 仍为 `MAC2` + `3002` |
| 7.1-5 `sysnet.bin` 一致、7.1-6 OTA `.z` | PASS | sysnet 328B 逐字节一致；`.z` 仍 ca + p 两份 |
| 7.2-1 冷启动 Post→AP | PASS | 空 ctrl 仍 `boot Post` → `Jumping to AP` |
| 7.2-2 首次进 ATE | PASS | `ATE_DONE=0` → `create bk_ate`（行为等价） |
| 7.2-3 置位后不擦除重烧仍正常 | PASS | 见下方日志 |
| 7.2-4 网页 OTA 保留 ATE_DONE | PASS | ca/p `upgrade ok`，升完仍 `boot=4` |
| 7.2-4 ATE 工装升级 | 流程通；保留未验到 | 升前被 option43 返工清位，与删 ctrl 无关 |
| 7.2-5 GPIO Recovery | 替代验证 | 产品未开该 GPIO；改测 Post stay：进 Post 不写 ctrl |

主目标（`ATE_DONE=1` 后不擦除重烧仍正常）真机日志（已脱敏）：

```
# ① set 1
ATE_DONE bit2 set (boot_flag 0x00 -> 0x04)
read raw: 4c 52 54 43 00 04 00 00 => ... boot=4

# ② 重启
ATE_DONE=1, default normal boot
create xui_main

# ③ 不擦除重烧截断后的 all-app，再启
read raw: 4c 52 54 43 00 04 00 00 => ... boot=4
ATE_DONE=1, default normal boot
create xui_main
```

网页 OTA 保留 bit2（需 PID 已写入）：`stream: ... CRC OK → reset_clean` → `commit: ... (boot=4 pending=0 result=1)`
→ `OTA result: upgrade ok` → 再启仍 `ATE_DONE=1`、`create xui_main`；升 p 同理。
未截断前对照：重烧后 ctrl 变 `ff…` → 又进 ATE。

### 未验到 / 替代验证的部分

- **ATE 工装路径的「保留 ATE_DONE」未验到**：长按进 ATE 后查仍是 `boot=4`（按键不写 Flash），
  但插入工装网触发 DHCP option43 返工，把 `0x04` 清成 `0x00`（发生在升级**之前**），
  因此升完查到 `ATE_DONE=0` **不能**据此否定 OTA 保留——网页路径已证明保留。
- **GPIO `cp_boot_select` 强制 Recovery 写 ctrl**：该产品未开此 GPIO，设计稿该项未按原文路径验证；
  改测 Post stay，结论是「进 Post ≠ 写 ctrl」（stay 前后 `read raw` 均为全 `FF`）。
- **未产测设备 OTA 后仍进 ATE**：不是「擦掉了 ATE_DONE」，而是「ATE_DONE 从未写过」；
  删 ctrl 前后行为一致，根因是产测未 `set_ate_done(1)` 就 OTA。
- **硬件版本识别实测**：V60P V2.0（~3025mV）、V60P V2.1（~3000mV）、V50P V2.0（~3026mV）
  ATE 与 legacy-app 判定一致。

---

## 结论、注意事项与遗留问题

### 结论

1. `all-app.bin` 不再包含 ctrl 分区内容，长度截断到 `0x7F8000`（8355840），烧录不再覆盖 Flash ctrl 区。
2. `sysnet.bin` 不变（328B，PID / GroupID 补丁，偏移 `0x7FF000`），Flash 分区表保留 ctrl 行。
3. 空 ctrl（全 `0xFF`）由固件 magic 无效降级为 clean 零值，**首次开机仍进 ATE**，与旧出厂 clean meta 等价。
4. 产测写入 `ATE_DONE=1` 后，不擦除重烧日常 `all-app.bin` 设备仍正常启动；网页 OTA 升完仍保留 `ATE_DONE`。
5. 版本差异以截断为准：相对移除前 Δ = **−64 字节**，不是设计稿预估的 −8192。

### 注意事项

1. **烧录器不得全片擦除**：只擦写镜像覆盖的扇区，否则 ctrl 仍会丢，与是否打包无关；也不要为「省事」删掉 `auto_partitions.csv` 的 ctrl 行。
2. **截断逻辑必须留在源码中**：若 `truncate_bin_to_packed_end` 被还原，`all-app.bin` 会重新变成 `0x7F8040` 并写穿 ctrl，需回归 7.1-3 / 7.2-3 两项。
3. **`0xFF` 降级依赖固件约定**「magic 无效 → 清零」（非协议规范）；若将来语义改为「无效即进 Recovery / 报错」，需重新评估出厂空 ctrl 的行为。
4. 产测判定不要混淆三个概念：界面在 ATE ≠ Flash bit2 为 0；进 Post ≠ 写 ctrl；工装 option43 返工会主动清位。

### 遗留问题

1. ATE 工装路径下「OTA 保留 `ATE_DONE`」需补测：应在 `ATE_DONE=1` 时不触发返工的条件下升一次 ca。
2. GPIO `cp_boot_select` 强制 Recovery 的写 ctrl 行为未按原文路径验证（产品未开该 GPIO）。
3. 方案 A（ctrl 并入 32KB sysnet）仍是设计稿，落地前需与任务方确认采用哪一份，避免两套方案并行造成歧义。
4. `v60g` / `v60w`（及未部署的 `v60p`）的 GPIO 硬件版本 conf 缺 V1.1 / V2.1，可清理或补全。
5. `commit` 的擦写断电窗口是固有风险，与本次改动无关，但排查「OTA 后进 ATE」时需先排除。

---

## 相关路径（已脱敏）

| 路径 | 说明 |
|------|------|
| `sdk-repo/projects/voip-project/fs_pack_manifest.json` | ctrl 是否进入打包的开关入口（本次改动点） |
| `sdk-repo/projects/voip-project/partitions/bk7258/auto_partitions.csv` | Flash 分区表（保留 ctrl 行） |
| `sdk-repo/projects/voip-project/partitions/bk7258/ota_pack.json` | OTA 过滤（`include_apps` 不含 ctrl） |
| `sdk-repo/tools/build_tools/build_process/bk_build_package.py` | 32 字节对齐 + 截断到已打包终点 |
| `sdk-repo/tools/build_tools/build_process/bk_sdk/bk_sdk_project.py` | `post_package` 在 OTA 后再截断 |
| `sdk-repo/tools/build_tools/build_process/bk_sdk/bk_fs_image_pack.py` | 数据分区合并进 `bk_package.json` 的逻辑 |
| `sdk-repo/tools/build_tools/build_process/bk_sdk/bk_ctrl_partition_gen.py` | 生成 `partitions/ctrl.bin`（保留） |
| `sdk-repo/tools/build_tools/build_process/bk_sdk/bk_curr_project.py`、`bk_project.py` | CRC 校验开关写死为开；`get_packager` 据此选带 CRC 打包器 |
| `sdk-repo/tools/env_tools/bk_py_libs/bk_packager/bk_packager_linear_crc.py`、`bk_packager_crc_decorator.py` | 带校验打包器；收尾 `post_link` 追加 34B `0xFF`；代码区插 CRC |
| `sdk-repo/ap/components/bk_thirdparty/fv_bk_ota/fv_bk_ota_ctrl.c`、`include/fv_bk_ota_ctrl.h` | 运行时读写 + `0xFF` 降级；`ATE_DONE` 等位定义 |
| `sdk-repo/cp/components/fv_cp_boot_ctrl/cp_boot_select.c` | GPIO 强制 Recovery（需 `CONFIG_FV_CP_BOOT_GPIO`） |

验证证据（打包 before/after 备份、真机与工装日志、构建产物目录）存于 `~/work/ate/` 与 `sdk-repo/build/bk7258/voip-project_v60e/package/`。

---

## 附：信息不足的源文件

- 本次 6 个源文件均有可归纳的有效内容，**没有**信息量过少、需单独剔除的文件。
- 两点说明：两份任务报告（正式版与过程版）正文高度重合，已合并去重；硬件版本号识别文档与 ctrl/ATE_DONE 主线无直接耦合，已在 §3.7 单独成节。
- 源文件中仅提及名称、无正文可归纳的部分：`boot_flag` 除 bit2 之外各位的逐位定义，以及 `factory_flash_segments.json` 中 `gap_is_all_0xFF` 校验的实现细节。
