# M4 发现与验收记录（独占 / 协商 / 降级 / 热插拔）

> 配套：`docs/M4-PLAN.md`（任务书）、`docs/REVIEW-PROTOCOL.md`（复核流程与 cb 后端）。
> 本文件记录**真机实测**结果与由此抓到并修复的缺陷——静态审查看不到的部分。

---

## 1. 硬件矩阵实测（§23 底数复核）

| 设备 | 独占能力 | 备注 |
|---|---|---|
| USB DAC `CX31993 MAX97220PRO AUDIO` | **16/24bit @44.1k–384k 全通过**，minPeriod 3ms | 默认设备，主力验证对象 |
| Realtek ALC256（内置） | ≤192k | 降级/回退目标 |
| Steam Streaming Speakers（虚拟） | 仅 16bit | M4-a 桩的假矩阵按此建模 |

**miniaudio WASAPI 枚举陷阱**：`nativeDataFormatCount` 恒为 0（三端点实测）→
`ExclusiveCapable()` 预探测永不成立 → 改为**"试开即探测"**（`ReopenForTrack` 直接
`ma_device_init(EXCLUSIVE)`，失败按真 `ma_result` 分类降级）。见 M4-PLAN §M4-a。

---

## 2. 交互点验收（用户在场）

### 交互① 独占听感 —— ✅ 通过（用户实测 09-15）

- 切 exclusive → 播放 FLAC：正常出声，徽章 `BIT-PERFECT`（`factors=[]`）。
- keep 语义（Q7）：其他应用被 Windows 自行切走/静音，本应用不让位。

### 交互⑤ 蓝牙独占 —— ⊘ **豁免**（用户裁定 09-15）

> "蓝牙哪来的独占"

Windows 的 A2DP 传输链路会强制重编码（SBC/AAC），不存在位完美直通路径；
`devices.list` 对其如实报"无独占"即为正确行为。**本项不再要求验证**。

### 交互④ 拔插 USB DAC —— ✅ 通过（真机两轮，抓到 3 个真缺陷）

流程：钉选 DAC + `output.mode=exclusive` → 播放（seek 90s+）→ 物理拔 DAC → 观察 → 插回。

**实测结果（修复后）**：

| 时刻 | state | share | position |
|---|---|---|---|
| 拔前 | playing | **exclusive** | 147831 ms |
| 拔后 t+18s | **playing**（未中断） | **shared-event** ✓ | 150278 ms |
| 拔后持续 | playing | shared-event | 持续推进（214918 ms…） |

- 位置**连续无回跳**（`maxJumpBackMs=0`），音频由扬声器接续出声。
- 插回后 `RestorePinnedIfAvailable` 切回原 DAC（用户钉选意图保留）。

**由真机实测抓到并修复的 3 个缺陷**（静态审查未能发现）：

| # | 缺陷 | 现象（用户可感知） | 修复 |
|---|---|---|---|
| 1 | 冻结位置漏写 | 拔设备后**进度归零**，续播从头开始 | `engine.cpp` 失败分支补 `lastPositionMs_ = frozenMs` |
| 2 | 钉选消失直接 failed | 拔 DAC 后**静默 paused**（M4-PLAN 交互④要求"自动切系统默认续播"） | 解钉回默认并重试 |
| 3 | 回退沿用 exclusive | 拔出后**仍显示独占**（用户现场原话："拔了之后…依然显示好像在独占"）——在未经授权的设备上抢独占，静音其它应用，违反 §15 | 回退一律用 shared |
| 4 | 解钉丢失用户意图 | 插回 DAC 也**不会切回**原设备 | 新增 `hasPinnedIntent_` 保留意图 + `RestorePinnedIfAvailable` |
| 5 | **回退态仍抢独占**（用户现场："拔掉 DAC 也正常播放 → 过了一会声音没了"） | 拔 DAC 后退到 Realtek，`ReopenForTrack` 仍按 `policy_.requested()=exclusive` 重开 → 在未授权设备抢独占（静音其它应用）；且 `MaybeRecoverExclusive` 每 5s 探测一次 → 反复重建链 → **听感中断** | 回退态（`hasPinnedIntent_ && !hasDeviceId_`）强制 shared；探测在回退态直接跳过，等钉选设备插回才探 |

**修复后长时验证（43.7 分钟曲目，0:00 起播 → 拔 DAC → 采样 180s）**：

| 指标 | 结果 |
|---|---|
| state | **90/90 全 `playing`**（零暂停） |
| share | 8 次 `exclusive`（拔前）+ 82 次 `shared-event`（拔后），**只切换 1 次** |
| 位置回跳 | **无**（11074 → 283959 ms，跨度与真实经过时间一致） |

**修复原则（值得记住）**：独占是用户对**特定设备**的显式授权。
设备变化 = 授权失效，必须降级 shared 重新征求（§15"独占绝不默认开"）。
但**用户的选择意图**要在内存里留着，设备回来时应恢复。

---

## 3. 机器可验证的冒烟（可重复执行）

```bash
# 三个脚本均为"真核心 / 桩"双模；真核心需要实际声卡
pwsh.exe -File 'C:\Users\StarL\m2-work\tools\m4-smoke\excl-smoke.ps1'    # 独占协商与徽章
pwsh.exe -File 'C:\Users\StarL\m2-work\tools\m4-smoke\expand-smoke.ps1'  # underrun 升档
pwsh.exe -File 'C:\Users\StarL\m2-work\tools\m4-smoke\select-smoke.ps1'  # 设备切换（含音量保持/位置不回退守护）
bash tools/output-policy-test/run.sh                                     # 策略状态机 35 checks
```

`select-smoke` 含两条**回归守护**（由 cb 复核抓到的缺陷转成断言）：
- 设 `hardware` 音量后触发设备重建，`master_volume` 必须保持（R2-P1-1）；
- 设备重开位置不得回退（R3-P1-1）。

---

## 4. 复核记录（CodeBuddy 无头模式，三轮）

审查后端与流程见 `docs/REVIEW-PROTOCOL.md`。三轮共抓 **5 个 P1**，其中 3 个是修复过程
自身引入的——**这印证了"修复必须复核"**：

| 轮 | 缺陷 | 触发场景 |
|---|---|---|
| R1 | 独占下音量条静默失效 | 拖音量条无反应（上轮回落改 `fixed(1.0)` 引入） |
| R1 | 歌词闩锁无解锁点 | 停止后重播同一曲 → 歌词永久空白 |
| R1 | `default` 哨兵未翻译 | 钉选后回不到"跟随系统默认"（核心 bad_request） |
| R1 | WSL 测试守卫**假绿** | "8/8 绿"实际没跑 `\n` 闭合断言 |
| R2 | 共享模式音量跨设备重开丢失 | **默认配置**下换曲音量回 100% |
| R3 | 设备失效续播用陈旧位置 | 拔 DAC 位置回跳（与交互④同源，静态先发现） |
| R3 | `bits_valid` 谎报 32bit | 16bit FLAC 的 UI 头条显示 32 bit |

---

## 5. 未完成 / 已豁免

| 项 | 状态 | 说明 |
|---|---|---|
| 交互⑤ 蓝牙 | ⊘ 豁免 | 用户裁定：蓝牙无独占（见 §2） |
| 30min underrun 长跑 | ⏸ 未做 | M4-PLAN 要求；`expand-smoke` 已覆盖升档逻辑，长跑属统计验证 |
| `volume.mode=integer` | ⏸ 未实现 | 定点位完美衰减；设置页已标占位灰显 |
| `output.on_device_gone=pause` | ⏸ 未实现 | 当前行为恒为"自动重开"；设置页已标占位灰显 |
| 核心崩溃自动重启 | ⏸ **分两步，本次留接缝** | `IPC-PROTOCOL.md:186` 有承诺但全仓无代码（cb R3 发现）；R5 已修启动路径（CoreLaunch 决策），重启监督待做 |

---

## 6. R5：发行版启动不拉起核心（**发布阻断级**，cb 定方案 + 真机实测）

**性质**：比上表任何一项都严重——**用户拿到 zip/exe 双击后完全无声、无法播放**。
M6-F 验收盲区：当时只验了前端产物定位（`ZIP-CLEAN-VERIFY` 验的是 `dist=...web`），
**没验核心生命周期**。

**现象（真机实测）**：解压 zip → 双击 `RhineShell.exe` →
```
=== 进程 ===
39748 RhineShell        <- 只有壳，无 RhineCore / RhineCoreStub
=== shell.log ===
warn core connection failed: The operation has timed out.
info core reconnect in 500ms attempt=1 ... attempt=5   <- 无限重连失败
```

**根因链（两层，cb 复核补出第二层）**：
1. 壳拉核唯一入口是 `--spawn-core`（`ShellOptions.cs:87`），而发行版 4 个启动入口
   （installer 开始菜单 `rhine.iss:51`、桌面 `:53`、完成页 `:56`、zip README）**都不带它**。
2. `--core-exe` 缺省**硬编码为桩**（`RhineCoreStub.exe`）——随包的真核心
   `core/RhineCore.exe` 就在同目录，却从不被选中。
3. 开发期从未暴露：4 个脚本（`m-verify:278` / `m1-run:89` / `smtc-check:107` / `m1-e2e`）
   都**替壳起了核**，壳的 spawn 分支零自动化覆盖。

**修法（默认值反转，方案 B）**：
- 无参数启动 ⇒ 拉起核心；按「显式 `--core-exe` > `core/RhineCore.exe` > `core/RhineCoreStub.exe`」选择。
- `--no-spawn-core` 供外部核心场景（4 个脚本已加；漏加也不坏——子核被管道互斥吸收为 `exit 3` 自灭，壳照连外部核）。
- 决策抽为纯逻辑 `CoreLaunch.Resolve`（零 WPF 依赖，WSL 可跑单测）。

**验证（可证伪）**：

| 手段 | 结果 |
|---|---|
| 真机：zip 解压 → **零参数**启动 | ✅ 自动拉起 `RhineCore pid=12748`、握手成功、无重连失败、关窗无残留 |
| 变异测试（改回旧行为） | ✅ `M6-LAUNCH-SMOKE-FAIL (5)` |
| 单测 `CoreLaunchTests` | ✅ 6/6（含"默认选真核心"） |
| `m-verify -Level full` | ✅ **10 步全绿**，含新增 `packaged-launch` |

**新增防复发资产**：`tools/m6-smoke/launch-smoke.ps1`（Tier-1 结构断言）、
`m-verify` 的 `packaged-launch` 用例、`package.ps1` 的产物断言（缺核心即 throw）。
