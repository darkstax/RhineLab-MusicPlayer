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
| 核心崩溃自动重启 | ❌ **未实现** | `IPC-PROTOCOL.md:186` 有承诺但全仓无代码（cb R3 发现） |
