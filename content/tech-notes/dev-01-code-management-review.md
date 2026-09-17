+++
title = '开发环境-01 代码管理与评审流程'
date = 2026-09-16T10:00:00+08:00
draft = false
weight = 6
+++

改了 xml，分支却没变。那段日子我一度怀疑 Git 在跟我玩障眼法。等好不容易把多仓的分支切换理顺，推 Gerrit 又被一句「缺 Change-Id」拦在门外。多仓代码管理这套流程，坑全在你不看的地方——下面按流程记一遍。

## 概述

本文整理日常开发中的三类内容：本地开发环境搭建、多仓库代码拉取（repo / manifest 机制）、分支切换与同步、cherry-pick 与 amend、提交与 Gerrit 评审流程；以及编译脚本、产物形式和常见报错的处置经验。

涉及平台与机型（保留原代号）：

- rk3506：w620w、i503x（同一套代码，通过不同 manifest 与分支区分）
- ssd21x：w610h、V6X（j600w）；px30：X7A、A330 / A330i（Android9/14/15 分支）
- 其他：V65、V67、EM60 等

代码托管与流转链路：开发者在本地仓库完成修改 → `git push` 到 Gerrit，Gerrit 生成 `change-Id` 并进入评审 → 评审通过后合并到主仓库 → 其他人再通过 `repo sync` 拉取到最新代码。GitLab 提供仓库托管与项目管理（含 CI/CD），Gerrit 专注提交前的代码评审，二者账号与 SSH 公钥需分别配置。

> 说明：本文只记录代码管理与编译相关的流程与排障，驱动（字符设备、GPIO、I2C/SPI/UART、DTS）等调试内容单独成篇。

## 环境与工具链

| 类别 | 内容 |
| --- | --- |
| 开发方式 | VS Code + Remote SSH 连接编译机（虚拟机 / 服务器） |
| 版本控制 | git、repo（多仓库 manifest 管理）、Gerrit（评审）、GitLab（托管 + CI/CD） |
| 编译环境 | rk3506 在 docker 容器 `rk3506-builder` 内编译；ssd21x / px30 使用各自 SDK 的 `build.sh` / `tobuild.sh` |
| 交叉工具链 | 例如 `gcc-sigmastar-9.1.0-2020.07-x86_64_arm-linux-gnueabihf`（内核模块交叉编译） |
| 板端调试 | 串口（波特率 115200）、tftp 传文件、adb push、`dmesg`、`devmem`、`i2cdump`/`i2cset`/`i2cget`、逻辑分析仪 |

环境配置的注意点：

1. **虚拟机磁盘要留足空间**。Android / RK 全量代码体积大，空间不足会在拉取中途失败；可参考磁盘扩容流程（扩容前建议先做快照，避免分区操作失败）。
2. 先打通 VS Code 远程连接，再在远端生成 SSH 密钥、配置 git 身份。
3. 编译机上推荐使用 docker 容器编译，保证工具链版本一致。

### 账号、SSH 与 git 基础配置

```bash
# 生成 SSH 密钥（GitLab 与 Gerrit 都需要添加这个公钥）
ssh-keygen -t rsa -C "team@example.com"
# 配置提交身份（团队账号）
git config --global user.email "team@example.com"
git config --global user.name "team"
git config --global ssh.variant ssh
git config --global credential.helper store
```

- `ssh-keygen` 生成 `id_rsa`（私钥）与 `id_rsa.pub`（公钥），公钥内容分别粘贴到 GitLab 的 SSH Keys 与 Gerrit 的 Settings → SSH Keys。
- 一个编译机上可能有多套密钥（如按项目区分），切换时载入对应私钥：`eval `keychain --eval ~/.ssh/id_rsa``。

## 技术流程（拉代码 / 切分支 / 编译 / 提交评审）

### 代码拉取与 repo manifest 机制

repo 用于管理「一个产品由几十上百个 git 仓库组成」的场景，核心是 manifest 文件：

- `repo init -u <manifests 仓库> -m <xml>`：初始化，在代码根目录生成 `.repo/`，并下载 manifest 仓库；
- `.repo/manifest.xml` 通常是指向 `.repo/manifests/<xxx>.xml` 的软链接，决定本次同步拉哪些仓库、分别取哪个分支/提交；
- `--repo-url` 指定 repo 工具本身从哪里下载（可用公网镜像加速）；
- `--reference` 指定本地已有的镜像目录，减少重复下载。

```bash
# ssd21x 开发分支
repo init --repo-url=ssh://git@git.example.com/repo-mir.git \
  -u ssh://git@gerrit.example.com:29418/sigmastar/manifests.git \
  -m FV_ssd21x_develop.xml

# rk3506 开发分支（带本地镜像加速）
repo init --repo-url=ssh://git@git.example.com/repo-mir.git \
  -u git@git.example.com:vendor-sdk/manifests.git -b rk3506g \
  -m rk3506g_dev_cicd.xml --reference=/home/data3/shared/rk3506-gerrit-mirror-py3
```

初始化后进入 `.repo/manifest.xml`，把 `user.name` / `user.email` 改成团队账号，再开始同步：

```bash
repo sync                # 普通同步（未指定并发时按默认）
repo sync -j1            # 单线程，便于定位是哪个仓库报错
repo sync -cd -j1        # -c 只同步当前分支；-d 切到 manifest 指定版本
repo sync -cd -j8        # 提高并发
```

**切换 / 更换 manifest 的两种做法：**

```bash
# 做法 1：直接替换链接（推荐，注意要在正确目录执行）
cd .repo/manifests
ln -s FV_ssd21x_release_ga1x.xml manifest.xml
ls -la                                   # 确认软链接指向正确
cd ../..
repo sync -m FV_ssd21x_release_ga1x.xml
```

```bash
# 做法 2：把 xml 拷进 .repo/manifests/ 并改名，同时把 .repo/manifest.xml 内容替换为同一份内容
# 若 .repo/ 下已存在 manifest.xml，ln 需要用 -f 强制覆盖，或先删除旧文件
ln -sf manifests/rk3506g_dev_cicd.xml manifest.xml
```

注意：`ln` 时的相对路径要相对 `.repo/` 目录，链接建好后必须 `ls -la` 确认，否则同步的仍然是旧 manifest，会出现「改了 xml 但分支没变」的假象。

### 分支切换与代码同步

同步最新代码前，先确认工作区是否干净，避免 repo 因本地修改而拒绝更新：

```bash
git status                                # 单个仓库
repo forall -c "git status"               # 所有仓库

# 确认本地修改都不要了，逐仓库清理
repo forall -c "git checkout ." && repo forall -c "git clean -df"
```

上述命令含义：`git checkout .` 丢弃已修改未暂存的文件；`git clean -df` 删除未跟踪的文件与目录（`-d` 含目录，`-f` 强制）；`&&` 表示前一条成功后才执行后一条。

```bash
# 强制与 manifest 保持一致（会丢弃本地修改和不在 manifest 分支上的提交）
repo sync -c --no-tags -j12 --force-sync
```

`-c`：只同步当前分支；`-d`：切换到 manifest 中指定的 revision；`--force-sync`：本地有冲突时放弃本地状态，强制覆盖，并删除不再由 manifest 管理的跟踪分支。

**切换分支的另一种做法（单仓库级别）：**

```bash
git fetch fv rk3506g_dev_cicd      # 从远程 fv 取指定分支（远程名可用 Tab 补全）
git checkout fv/rk3506g_dev_cicd   # 切到该分支
# 或：fetch 时直接建立本地同名分支
git fetch fv rk3506g_dev_cicd:rk3506g_dev_cicd
git branch                         # 确认当前分支
```

`git fetch <remote> <branch>` 只把远程数据取到本地，不会改 `origin/<branch>`；本地已存在同名分支时做 fast-forward 更新，不存在时按该远程分支新建。

**多仓库彻底清理（重来一遍）：**

```bash
repo forall -c 'git reset --hard HEAD; git clean -fdx'
repo sync -cd -j8 --force-sync
repo status                          # 期望显示 clean
```

### cherry-pick 与 amend

**cherry-pick 单个未合并提交**：先在 GitLab 上找到目标提交的哈希，然后到对应仓库里 pick，**通常不需要切分支**，直接在目标位置执行：

```bash
git cherry-pick fb8e6f74525a5a980682e3926bcdd2412638f8fa
```

如果确认该处本地修改不需要保留，也可以直接检出该提交来丢弃本地改动：

```bash
git checkout fb8e6f74525a5a980682e3926bcdd2412638f8fa
```

**补交 / 修改最近一次提交**（改代码或改提交信息）：

```bash
git add .
git commit --amend              # 修改最近一次提交（信息或内容）
git commit --amend --no-edit    # 只补内容，不改提交信息
git push
```

**Gerrit 场景下 amend 会重新生成 Change-Id 对应关系，前提是仓库里装了 `commit-msg` 钩子**：

```bash
# 单个仓库安装钩子
f="$(git rev-parse --git-dir)/hooks/commit-msg"
curl -o "$f" http://gerrit.example.com:8081/tools/hooks/commit-msg
chmod +x "$f"
```

```bash
# repo 管理的全部仓库批量安装钩子
repo forall -c "rm -rf .git/hooks"
repo forall -c "mkdir -p `git rev-parse --git-dir`/hooks/ && curl -Lo `git rev-parse --git-dir`/hooks/commit-msg http://gerrit.example.com:8081/tools/hooks/commit-msg && chmod +x `git rev-parse --git-dir`/hooks/commit-msg"

git commit --amend              # 编辑器中 Ctrl+S 保存、Ctrl+X 退出
```

> 注意：`repo forall -c "rm -rf .git/hooks"` 会先清掉旧钩子，再重新下载，保证钩子是最新的。

### 提交与 Gerrit 评审流程

提交信息格式（本团队约定）：

```
[账号] [问题单号] [类型] [机型] : 描述
```

类型常用 `[Feature]` / `[Bug]` / `[Requirement]`；一个提交可关联多个单号（如 `[T118176/T116610]`）。示例（账号已统一为 `TEAM`）：

```bash
git status
git add .
git commit -m "[TEAM] [T102486] [Feature] [V65] : 增加 ATE 蓝牙 rssi 测试功能"
git push
git push sigmastar HEAD:refs/for/RELEASE_CICD
```

推送到 Gerrit 的评审地址（`refs/for/<目标分支>`），可用 `-o topic=<单号>` 把同任务的多笔提交归到同一 topic：

```bash
git push fv HEAD:refs/for/rk3506g_dev_cicd -o topic=T110677
git push ng HEAD:refs/for/develop-android15 -o topic=T111233
git push overlay HEAD:refs/for/master -o topic=T121315
```

**推到新分支 / 新远程仓库**（远程名需先在 `git remote` 里存在，否则先 add）：

```bash
git remote add team git@git.example.com:fv_px30_android9_overlay/vendor_apps_factorytest.git
git remote -v                       # 确认远程地址，避免推错库
git push team Team_Feature_PX30_T98908_fv_dev_xseries_ATEtonetest
```

**提交源码到新建的空仓库**：

```bash
cd ~/work/repo/android15/vendor/vendor/apps/SystemUpdate
git init                                        # 若不是 git 仓库才需要
git remote add origin git@git.example.com:open-tools/system-updater.git
git add .
git commit -m "[TEAM] [T111233] [Feature] [A330/A330i] :Add SystemUpdate source code."
git push -u origin master
```

**单独 clone 一个仓库改代码并提交**（先确认该仓库在 Gerrit 还是 GitLab 上，并找到对应分支）：

```bash
git clone "ssh://git@gerrit.example.com:29418/fv_px30_android9_overlay/hardware_rockchip_camera"
git branch
git checkout fv_stable_v67_satel_xseries
git push origin HEAD:refs/for/fv_stable_v67_satel_xseries
```

### 编译脚本与产物

`build.sh` 参数约定：

```
[-p product] [-t type] [-v version] [-u user] [-d debug]
```

其中 `-p`（产品型号）与 `-t`（编译哪一部分）必选，`-u` 用于区分客户版本（如 `vendor` / `Linkvil`），`-v` 指定版本号。

```bash
./build.sh -p w620w -t all                      # 全编
./build.sh -p w620w -t kernel -u vendor -v T0.0.1
./build.sh -p w620w -t firmware                 # 只生成固件
./build.sh -p w620w -t packet                   # 打版本包
./build.sh -p w620w -v aaaa -t packet           # 带版本号打包
```

**分层编译**（全编或某层报错时，按依赖顺序逐层编）：

```bash
./build.sh -p w620w -t pkg-only xapp_resource
./build.sh -p w620w -t pkg-only mscore
./build.sh -p w620w -t pkg mscore               # 编 mscore 时会一并编 x_app
./build.sh -p w620w -t app
./build.sh -p w620w -t project
```

**在容器内编译 rk3506**：

```bash
docker ps                                                    # 查看正在运行的容器
docker exec -u $(id -u):$(id -g) -it rk3506-builder /bin/bash
cd ~/work/repo/rk3506
./build.sh -p w620w -t all -u vendor -v T0.0.1
```

**px30 / Android 侧脚本编译**：

```bash
dexec aosp9-builder
clean_env
source build/envsetup.sh
set_vendor_product X7A vendor
lunch 13
./tobuild.sh X7A hualuo all
```

产物与烧录：

- ssd21x 侧编译结束后生成 `image <product>` 文件，通过 tftp 网络烧录；首次烧录需先设置板子与 PC 的 IP（`setenv ipaddr` / `setenv serverip`，`save` 保存），ping 通后再烧。
- px30 侧产物在 `/px30/rockdev/Image-rk3326_m2g` 等目录下（如 `boot.img`），支持只烧某个分区；`tobuild.sh` 虽然不一定生成完整固件，但会把各分区文件重新生成好供单独烧录。

## 问题与调试记录

### 拉代码不成功（Gerrit / SSH 认证）

- **现象/定位**：`repo init` / `repo sync` 阶段直接失败，或同步过程中反复提示输入密码且认证失败；确认公钥是否已分别加到 GitLab 与 Gerrit，确认 manifest 里 URL 中的用户名是否正确，必要时单独 clone 一个仓库验证认证链路。
- **根因**：SSH 公钥未在 Gerrit 侧配置 / manifest 中带有错误的用户名前缀。
- **解决**：把 `id_rsa.pub` 分别加到 GitLab 与 Gerrit；并在 manifest（xml）中把 `username@http://git.example.com:8083` 一类的写法中的 `username@` 去掉。
- **验证**：单开一个目录先单独 clone 该仓库能成功，再回到产品目录执行同步。

### w610h 代码同步反复要求输密码

- **现象**：`repo sync -j1` 需要输入密码，输入密钥后仍提示认证失败。
- **定位**：到内网 Git 服务器的仓库页面（`http://git.example.com:8083/admin/repos/...`）复制该仓库地址，单独建目录 clone，可以拉下来。
- **根因**：manifest 中的仓库地址带了用户名，走成了需要密码的认证方式。
- **解决**：找到对应 xml，把 URL 中的 `username@` 删除后再同步。
- **验证**：先 `repo sync -j1 -cd` 单线程同步成功，再提高到 `repo sync -j8 -cd`。

### repo sync 报「本地有修改，无法覆盖」

- **现象**：切分支后编译报错（例如 xapp 提示宏定义与旧分支冲突），再执行 `repo sync -c` 时报错，提示本地修改无法被覆盖。
- **定位**：`git log` / `git status` 查看具体是哪个文件、是否还需要这些修改。
- **根因**：本地工作区存在未提交改动，repo 拒绝覆盖。
- **解决**：不需要的修改直接放弃（`repo forall -c "git checkout ." && repo forall -c "git clean -df"`）；需要保留的先 `git stash`，同步后再 `git stash pop`；随后用 `repo sync --force-sync -cd` 强制同步。
- **验证**：切分支成功后重新编译，宏定义冲突消失。

### --force-sync 之后本地提交「消失」

- **现象**：为了排查问题做了一个 `test1` 提交，执行 `repo sync -c -j12 --force-sync` 后 `git log` 里找不到该提交。
- **根因**：`--force-sync` 会丢弃所有不在 manifest 指定分支上的本地修改与提交。
- **解决/结论**：待排查的本地改动不要用 commit 挂在当前分支上，改用 `git stash` 或新建分支保存；确认废弃后再 force-sync。

### 编译报错：Fail to build rootfs

- **现象**：连续编译均失败，报 `Fail to build rootfs`；怀疑依赖上一轮残留产物。
- **解决**：确认没有需要保留的内容后，直接删除 `output` 目录，再 `repo sync -cd`，然后重新编 all。
- **验证**：重新全编通过。

### 编译某层报错 → 按依赖顺序分层编译

- **现象**：直接编 app 报错。
- **定位/解决**：按依赖顺序先编资源与公共库，再编 app，最后编 project：

```bash
./build.sh -p w620w -t pkg-only xapp_resource
./build.sh -p w620w -t pkg-only mscore
./build.sh -p w620w -t pkg mscore
./build.sh -p w620w -t app
./build.sh -p w620w -t project
```

- **结论**：**哪里报错就单独编哪里**，逐层推进比直接全编更容易定位。

### 缺少 Change-Id / hooks 相关问题

- **现象 1**：push 被拒绝，提示 `missing Change-Id in message footer`。
- **根因**：本地仓库没有 `commit-msg` 钩子，无法自动生成 Change-Id。
- **解决**：按下载钩子命令安装到 `.git/hooks/commit-msg` 并加执行权限，然后 `git commit --amend`（保存退出后即会写入 Change-Id），再重新 push。
- **现象 2**：推送后页面显示为「二进制修改」；**处理**：确认文件类型与 `.gitattributes` / 换行符设置，避免把文本文件当成二进制提交。
- **现象 3**：拉取 git 库时 `permission denied (publickey)`；**处理**：检查本机是否载入了正确的私钥，以及公钥是否已添加到对应平台。

### 同步报错后手动改回 xml / 权限问题

- **现象/定位**：强制清理 + 同步仍然报错；`git restore remote.xml` 后再次同步会暴露权限问题。
- **解决**：此时再回到 xml 修改（改回正确内容/正确用户名），随后 `repo sync -cd -j8 --force-sync`。
- **验证**：`repo status` 显示 clean。

### cherry-pick 后编译报错，根因在别的仓库

- **现象/定位**：pick 了一个修改后编译报错，报错位置却不在 pick 的仓库里（例如 `frameworks/opt/net/ethernet/java/com/android/server/ethernet` 下的文件）；向上追溯该报错文件的修改历史。
- **根因**：该处依赖的是很早之前的一次修改，且早已合并；当前仓库的分支不是包含该修改的分支。
- **解决**：把该路径下仓库切到正确的分支后再编译。
- **验证**：编译通过。

### 单独编 bootimage + 刷空 vbmeta 导致无法开机

- **现象/根因**：为验证某项改动（LCD UI 水平翻转）单独 `make bootimage -j8`，并按提示刷入空的 vbmeta（空 vbmeta 源文件由同事提供），刷完后设备无法正常启动；单独编译产物缺少依赖/签名环节。
- **解决**：改用脚本编译并烧录对应分区：

```bash
./tobuild.sh X7A hualuo all
# 只烧 /px30/rockdev/Image-rk3326_m2g 下的 boot.img 与空的 vbmeta
```

- **验证**：脚本编译后设备启动正常；结论是后续优先用脚本编译，避免手工 make 造成依赖缺失。

### make systemimage 后设备启动即崩溃

- **现象**：烧入 `make systemimage -j16` 的产物，能启动但立刻黑屏、系统崩溃。
- **根因**：编译时缺少部分依赖；表现为核心服务 zygote 反复崩溃并被强杀（signal 9），Android 框架（SystemUI、Launcher）无法起来，于是黑屏。
- **解决/验证**：改用脚本编译（如 `./tobuild.sh X7A hualuo all`）保证依赖完整，脚本产物烧录后启动正常。

### 内核模块编译报 `make: Nothing to be done for 'build'.`

- **现象/定位**：编写 `hello.c` 与 `Makefile` 后 `make` 无任何动作，检查 Makefile 中的内核源码树路径变量。
- **根因**：`Makefile` 里 `KERNELDIR` 指向的内核目录写错。
- **解决**：把 `KERNELDIR` 改为正确的内核源码树路径后重新 make。
- **验证**：生成 `.ko` 文件，交叉编译成功。

### 新增驱动没有被编进内核

- **现象/定位**：新增驱动源码、改了同目录的 `Kconfig` 与 `Makefile` 后编译，内核里没有该模块；查看该产品 defconfig 是否启用了对应宏、kernel 目录下的 `.config`。
- **根因**：`build.sh` 先从产品 defconfig（如 `rk3506g_w620w_defconfig`）生成 `.config` 再编译，只改 Kconfig/Makefile 但没有在 defconfig 里启用，等于没告诉系统要编这个模块。
- **解决**：在 `arch/arm/configs/<product>_defconfig` 中加上 `CONFIG_XXX=y`（或 `=m`），再编 kernel。
- **验证**：对应目录下生成 `.o`/`.ko`，`.config` 中出现该宏。

### repo init 的 Python 版本报错

- **现象**：`repo init` 阶段报 Python 相关错误。
- **解决**：改用公网 git-repo（指定分支版本）再 init：

```bash
repo init --repo-url=https://mirrors.tuna.tsinghua.edu.cn/git/git-repo --repo-branch=v2.56 \
  -u ssh://git@git.example.com/sigmastar/manifests.git -m FV_mobile_wifi_release.xml
```

- **验证**：init 通过后可正常 `repo sync -j8`。

### 磁盘空间不足与虚拟机快照链错误

- **现象 1**：拉代码过程中报磁盘空间不足；**解决**：按磁盘扩容流程扩分区，虚拟机初始配置时就应把空间设大（不超过宿主机可承受范围）。
- **现象 2/根因**：扩容后报「在部分链上无法执行所调用的函数，请打开父虚拟磁盘」——之前创建过快照，删除后残留文件未清理干净，快照链不完整。
- **解决**：重新创建一个快照，然后在快照管理器中删除该快照。
- **验证**：虚拟机可正常启动；但最后一步调整分区大小时仍出现过问题，稳妥做法是重建虚拟机时直接给足空间，或先把代码目录换到空间充足的路径再重新拉取。

## 常用命令速查

| 命令 | 作用 |
| --- | --- |
| `git branch -vv` / `git branch` | 查看本地分支及其跟踪关系 / 当前分支 |
| `git checkout <branch>` / `git checkout -b <new>` | 切换分支 / 新建并切换分支 |
| `git fetch <remote> <branch>` | 只拉取远程分支数据，不自动合并 |
| `git fetch <remote> <branch>:<branch>` | 拉取并建立本地同名分支 |
| `git stash` / `git stash pop` | 临时保存 / 恢复本地修改（切分支前使用） |
| `git cherry-pick <sha>` | 把指定提交应用到当前分支 |
| `git commit --amend` / `--amend --no-edit` | 修改最近一次提交（内容/信息） |
| `git commit -m "..."` | 提交，信息按 `[账号][单号][类型][机型]:描述` 格式 |
| `git push <remote> HEAD:refs/for/<branch> -o topic=Txxxxx` | 推送到 Gerrit 评审，并用 topic 按任务归集 |
| `git remote add <name> <url>` / `git remote -v` | 添加 / 查看远程仓库 |
| `repo init -u <manifests> -m <xml>` | 初始化 repo 并指定 manifest |
| `repo sync -c -j12 --force-sync` | 强制同步到 manifest 指定状态 |
| `repo forall -c "git status"` | 逐仓库查看状态 |
| `repo forall -c "git checkout ." && repo forall -c "git clean -df"` | 逐仓库丢弃修改并删除未跟踪文件 |
| `repo forall -c 'git reset --hard HEAD; git clean -fdx'` | 逐仓库彻底清理（含忽略文件） |
| `repo status` | 查看整体是否 clean |
| `eval \`keychain --eval ~/.ssh/id_rsa\`` | 切换/载入指定 SSH 私钥 |
| `./build.sh -p <product> -t <type> [-v <ver>] [-u <user>]` | 编译（-p/-t 必选） |
| `docker ps` / `docker exec -u $(id -u):$(id -g) -it <container> /bin/bash` | 查看/进入编译容器 |
| `./tobuild.sh <product> <variant> all` | px30/Android 侧脚本编译 |

## 注意事项

1. **目录要对**：`ln` 建软链接、`build.sh`、`repo sync` 都要在正确目录下执行；操作后一定用 `ls -la`、`git branch`、`repo status` 复核结果，不要凭「应该切过去了」下结论。
2. **先备份再强制**：`repo sync --force-sync`、`git clean -fdx`、`git reset --hard` 都会不可逆地丢弃本地改动与未提交提交；确有需要先用 `git stash` 或新建分支保存。
3. **manifest 是分支的唯一依据**：切产品/切分支本质是换 xml；xml 建错链接或没生效，会表现为「代码没更新」「分支没切成功」「宏定义冲突」等一堆假故障。
4. **钩子决定 Change-Id**：新仓库或换了机器，先装 `commit-msg` 钩子再提交，否则 push 会被拒。批量安装钩子前会先删除旧钩子目录，注意别删错路径。
5. **提交信息规范化**：`[账号][问题单号][类型][机型]:描述`，多单号用 `/` 连接；同任务多仓库提交用 `-o topic=<单号>` 关联，便于评审与回溯。
6. **优先脚本编译**：手工 `make xxx -jN` 容易缺依赖（如 zygote 反复崩溃、单独刷 boot.img + 空 vbmeta 无法启动），除非明确只烧某个分区，否则用 `build.sh` / `tobuild.sh`。
7. **及时清理产物**：出现 `Fail to build rootfs` 一类疑似脏产物导致的失败，先删 `output` 再重编。
8. **提交前剥离个人信息**：不要把本地账号、个人路径、调试用临时提交带到公共仓库；推送前用 `git log` 复核提交内容与作者信息。
9. **磁盘空间**：拉取大代码前预留足够空间，虚拟机/快照操作要谨慎，避免快照链损坏导致无法开机。
