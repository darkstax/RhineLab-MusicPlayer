# 复核任务书与评审协议（RhineLab-MusicPlayer）

> 用途：把"审查"变成可交接的**可执行任务书**——任何具备 read/bash 能力的 agent（reviewer 角色）
> 拿到本文件即可独立开工，不需要额外口头上下文。
> 本文件 §1–§6 是**通用评审协议**（改 §7 的范围即可复用于任何里程碑）；§7 起是**本轮任务**。
>
> 生成时间：09-15 · 基线 HEAD：`8c9ca62` · 任务类型：**只读复核（第二轮）**

---

## 1. 角色与硬性纪律

| 项 | 规定 |
|---|---|
| 角色 | 审查者（reviewer）。**只读**：不修改任何文件、不 `git add/commit/push`、不删除文件 |
| 允许 | `git show/log/diff`、`rg`/`grep`/`find`、读文件、跑**廉价**验证（见 §5） |
| 禁止 | 全量重跑 `m-verify`（与其它泳道抢 robocopy 镜像与命名管道，见 §5 注意）；改代码"顺手修一下" |
| 范围 | **以改动 diff 及直接受其影响的调用链为边界**。除非被明确要求全量审计，diff 之外的存量问题不开单 |
| 工期 | 单轮建议 ≤ 40 分钟；超时先交已确证部分（宁可少而准） |

### 执行后端：reviewer 一律走 CodeBuddy 无头模式（09-15 用户裁定）

pi 的 subagent 在"长任务书 + 大仓库审查"下反复 503（上游流截断），**本项目 review 型任务改走
CodeBuddy Code 无头模式**（`codebuddy -p`，v2.151.0 已装，模型 `deepseek-v4.1-flash` + `--effort max`）：

```bash
# 标准调用（任务书走 stdin，规避长中文 argv 问题；-y 免交互授权）
cd /home/starl/ai-code/RhineLab-MusicPlayer
codebuddy -p -y --model deepseek-v4.1-flash --effort max \
  --allowedTools "Bash,Read,Grep,Glob" < docs/REVIEW-PROTOCOL.md

# 后台跑（长任务，不占前台；用 ps/logs 跟踪）
codebuddy -p -y --bg --name review-m4 --model deepseek-v4.1-flash --effort max \
  --allowedTools "Bash,Read,Grep,Glob" < docs/REVIEW-PROTOCOL.md
codebuddy ps            # 列出后台会话
codebuddy logs review-m4
```

**实测效力（本项目已验证，非纸面）**：cb 首轮复核在 M4/M5/M6 六笔修复中抓到
**3 个 P1（其中 2 个是我自己修复时引入的）**，且全部附了可复现证据：
- "独占下音量条静默失效"——追到 `player-store.ts:393` 恒定发 `hardware` + 我上轮把回落
  改成了 `fixed(1.0)`；
- "歌词闩锁无解锁点"——用 `node --test` 复现脚本证明"停止后重播同一曲歌词永久空白"；
- "`default` 哨兵未翻译"——用真核心实测 `devices.select{id:"default"}` 必 `bad_request`。
第二轮又抓到"共享模式音量跨设备重开静默丢失"（用本项目 vendored miniaudio 的 null 后端实测）。
结论：**cb 无头模式在本项目是有效审查后端**，不是走过场。

要点（实测确认）：
- `-y`（`--dangerously-skip-permissions`）是 `-p` 的必需项，否则读写/命令会被拦。
- `--effort` 支持 `minimal/low/medium/high/xhigh/max`；**本项目用 `max`**。
- `--output-format json|stream-json` 可程序化消费；`--json-schema` 可强制结构化输出。
- 用 `--allowedTools` 限权（reviewer 只需读类工具，**不要给 Edit/Write**，从机制上保证只读）。
- 长任务书用 stdin 管道喂入，避免 argv 的 UTF-8 与长度限制。

### 信任边界（本项目属性，直接决定什么算缺陷）

这是**本地单机桌面应用**：

- 命名管道 `\\.\pipe\rhine-music.*` **只由自家主程序（RhineShell）连接**，不是网络输入。
- 核心 ⇄ 壳的 JSON 帧、本地配置文件、SQLite 曲库，都属**内部通道**。
- 因此：非法值出现时，**首先怀疑自家发送端有 bug（去修发送端）**，不要求接收端具备抵抗任意
  注入/MITM 的能力；**不为假想攻击面开"必须修复"单**。
- 真实边界问题才按安全缺陷处理：网络输入、权限提升、凭据泄露、任意文件写入（路径来自外部）。

### 分级定义（宁缺毋滥）

| 级别 | 判据（必须同时满足） | 处置 |
|---|---|---|
| **P0** | 正常使用路径必然触发；导致数据损坏、崩溃、功能完全不可用 | 合并前必修 |
| **P1** | 正常使用路径**可触发**（给出触发场景）；影响用户可见的正确性/功能 | 合并前必修 |
| **P2** | 边界/罕见路径才触发，或有诚实的降级但表述误导 | 记入 FINDINGS，可延后 |
| 不提 | 纯措辞、代码风格、diff 外存量问题、"理论上可能"的风险 | 一句话说明为何不要求修 |

**反例（不要开单）**："如果攻击者能连上命名管道就能注入命令"——本项目没有这样的攻击者。
**正例（要开单）**：`WriteAsync` 不补行尾 → 冻结协议的对端永远等不到 `\n` → 功能失效（M5c P0-1）。

## 2. 证据规则（本协议的核心）

> **禁止**："看起来可能有问题"、"建议加固"、"理论上"。
> **必须**：每条结论附 **文件:行号** 或 **命令原文+输出**；说"已闭环"也要给验证命令与输出。

三种合格证据：

1. **代码证据**：`host/core/src/audio.cpp:289` —— 附关键 3 行上下文。
2. **复现证据**：给出能跑的最小命令，及你实际观察到的输出（贴原文，不要转述）。
3. **反证证据**：若你怀疑某项没闭环，先尝试**证伪自己**（读全调用链），证伪失败才开单，
   并在单里写明"已查过 X 路径，确认不覆盖"。

## 3. 环境前提

```bash
# 仓库（WSL 侧，写码与 git 用）
cd /home/starl/ai-code/RhineLab-MusicPlayer

# Windows 侧镜像（构建/运行的产物在盘符路径下）
#   C:\Users\StarL\m2-work\host    ← scripts/m2-build.ps1 的镜像
#   C:\Users\StarL\m2-work\tools   ← 冒烟脚本运行处
#   %LOCALAPPDATA%\RhineMusic\work ← m-verify 的镜像与 runs 目录
```

- 需要网络的命令（npm/dotnet restore/GitHub）先 `export https_proxy=http://127.0.0.1:7897`；
  访问本机服务（CDP、命名管道）要 `NO_PROXY='*'` 并清代理。
- **UNC 路径（`\\wsl.localhost\...`）不能作为 `Start-Process -FilePath` / dotnet/cwd**，
  必须用盘符路径（`C:\...`）——这是本项目踩过多次的坑。
- 子代理通道：`cli2api-goat/deepseek/deepseek-v4-flash`（`thinking: max`）；
  图像任务走 `vision`（gemini）。阿里云通道当前**欠费不可用**。

## 4. 输出格式（必须照此结构）

```markdown
# 复核报告：<范围> @ <HEAD sha>

## 总判定
本轮 <N> 笔修复：闭环 / 部分闭环 / 未闭环。
（一句话结论 + 你实际跑过的验证命令清单）

## P0
### P0-1 <一句话标题>
- **结论**：<问题陈述，含"正常使用路径如何触发">
- **证据**：<文件:行 或 命令+输出原文>
- **最小复现**：<可直接粘贴运行的命令>
- **建议修法**：<具体到函数/行为，不要泛泛而谈>

## P1
（同上结构）

## P2
（只列"标题 + 文件:行"，不展开）

## 已核实闭环的项
| 项 | 结论 | 验证证据（命令/文件:行） |
|---|---|---|
```

写入 `docs/REVIEW-<范围>-R<n>.md` 或任务指定的路径，并在回复里给 P0/P1 摘要。

## 5. 廉价验证命令清单（本项目实测可用）

```bash
# 前端单测（秒级，无副作用）
node --test src/settings/settings.test.mjs                    # 25
node --test src/player/lyrics/lrc.test.mjs                    # 26
node --test src/player/lyrics/lyric-view.test.mjs             # 4
node --test src/data.test.mjs                                 # 7
node --test src/player/covers/covers.test.mjs                 # 12
node --test src/player/library/library-store.test.mjs         # 4

# C++ 策略状态机（秒级）
bash tools/output-policy-test/run.sh                           # 35

# .NET 单测（需代理，约 30s）
export https_proxy=http://127.0.0.1:7897
dotnet test host/RhineCoreTests  -c Release --nologo           # 34
dotnet test host/RhineShell.Tests -c Release --nologo          # 8

# 类型/契约检查
npx tsc --noEmit
node scripts/check-shell.mjs        # 壳/前端契约，期望 "passed": true

# M4 冒烟（真核心，**非串行阶段请勿并发跑**：抢设备与管道）
pwsh.exe -NoProfile -File 'C:\Users\StarL\m2-work\tools\m4-smoke\excl-smoke.ps1'
pwsh.exe -NoProfile -File 'C:\Users\StarL\m2-work\tools\m4-smoke\expand-smoke.ps1'
pwsh.exe -NoProfile -File 'C:\Users\StarL\m2-work\tools\m4-smoke\select-smoke.ps1'
```

**注意**：`m-verify` 会 `robocopy /MIR` 覆盖镜像并占用命名管道，**与其它泳道并发必互踩**
（假失败）。复核阶段不要跑它；主进程已跑：`quick` 全绿（fingerprint `9e278c9`）。

## 6. 完成定义（DoD）

复核任务**完成**的标志（缺一不可）：

- [ ] 报告含 §4 全部小节；每条 P0/P1 都有证据与最小复现。
- [ ] 明确给出**总判定**（闭环/部分闭环/未闭环）+ 你实际执行过的验证命令清单。
- [ ] 对任务书中列出的每个"必答问题"，逐条给出答复（不要跳过难答的）。
- [ ] 未修改仓库任何文件（`git status` 干净）。

---

# 7. 本轮任务：M4 独占/协商/降级/热插拔 + 审查修复批次复核

## 7.1 背景

第一轮审查（M4-a/b/c/d、M5b/c/d、M6-E/F）提出的 P0/P1/P2 已落地为 **6 笔提交**。
本轮要回答的唯一问题：**这 6 笔修复是否真闭环，有无新引入缺陷。**

## 7.2 变更清单（逐笔 `git show <sha>` 审）

| # | SHA | 范围 | 修复内容 |
|---|---|---|---|
| 1 | `38b6166` | M5c 任务栏 | `WriteAsync`→`WriteLineAsync`（帧永不 `\n` 闭合 = 冻结协议失效）；写序加 `SemaphoreSlim`；`taskbar.set` ack 补 `{connected}` 真连接态；解除 WSL 命名管道早退守卫 |
| 2 | `7e5cb04` | M4 核心 | ①跟随默认不再钉 device id；②独占失败按 `ma_result` 真分类；③独占下 hardware 音量核心侧回落 fixed；④`Negotiated` 补 masterVolumeFactor 校验；⑤独占授予非 s32 拒开 |
| 3 | `e9c5ec4` | M4 打包 | `ResolveDist` 增 `<exe 同级>/web/` 候选（发布阻断：干净机 zip 解压后找不到前端产物） |
| 4 | `9e278c9` | M5b/M5d/设置 | 歌词 stop→position:0 不复活；详情页 EXPORT 改回 button；页脚标注截断；删死约束键 |
| 5 | `8fc1844` | M4/M6 P2 | `deviceLostSeen_` 死旗修正；`period_ms` 未知报 null；`on_device_gone` 占位灰显 |
| 6 | `8c9ca62` | M5b 纵深 | 抑制旗下沉 `LyricView.clear()`（`clearedSilent` + 作废旧进度）+ 永久回归用例 |

**基线之前的上下文**（这些是"原始实现"，修复是相对它们做的）：
`3cf24b5`(M4-d) / `cc72df2`(M4-c) / `19bd8f5`(M4-b) / `4a3a114`(M4-a policy) / `09f2bab`(M6-F 只读面)。

## 7.3 必答问题（逐条答复，不许跳过）

### A. 修复是否真闭环

1. **M5c**：`WriteLineAsync` 是否在**所有**写路径生效（set/clear/quit 帧各一条）？
   `SemaphoreSlim` 覆盖范围是否完整（含异常路径的 release）？
   `Bridge.TaskbarConnectedProbe` 是否真被 `TaskbarWiring` 注入（若没接，`connected` 恒 false = 新谎报）？
2. **M4 P1-2**：`CacheDefaultEndpoint` 去掉 pin 后，三条路径语义是否自洽——
   ①`devices.select` 空 id 回默认 ②显式钉选 ③`ReopenForTrack` 跟随默认。
   是否仍有地方读 `lastDeviceId_`（可能已是陈旧值）？
3. **M4 P1-3**：`ma_result` 分类中 `rc < 0` 兜底是否**过宽**（把可恢复的瞬态失败也归
   `FormatUnsupported` → 永不重试）？`Negotiate` 内 buffer 抬档是否仍会污染持久 `bufferMs_`
   （棘轮残留：抬上去就降不回来）？
4. **M4 P1-4**：exclusive ∧ hardware → fixed 的回落点，是否覆盖 `SetVolume` **之外**的入口
   （启动时配置回放、preset 应用、`SyncOutputConfigToCore`）？
   `Engine::volumeMode_` 与 `AudioBackend::volumeMode_` 是否会不一致（ack 谎报 effective）？
5. **M4 P2**：`masterVolumeFactor` 校验在 const 方法里用 `const_cast` 读设备——
   是否存在未初始化窗口（设备未 open 时）或数据竞争？
6. **M5b P1-1**：`clearedSilent` + `lastPositionMs=-1` 是否**伤及正常切曲**
   （新 `setText` 后、首个 position 到达前的面板/任务栏显示）？`setText(null)`（无词曲）后
   是否**永不恢复**（后续 position 全被吞）？
7. **M5d P1-2**：详情页改 button 后，**web 模式**那处 `<a download>`（静态档案文件）是否未被误伤？
8. **M5d P1-5**：页脚 `wallMode.truncated && shown < albums` 是否会漏报/误报
   （追 `data.ts` 的 truncated 置位条件与 `records.length` 语义）？

### B. 有无新引入缺陷

- 上述 6 笔是否引入回归（越界、空指针、死循环、协议形状变化）？
- **桩与核心是否同步**：`host/RhineCoreStub` 是否跟上了核心的新行为
  （`period_ms` null / 失败分类 / exclusive 非 s32 拒开）？不同步会不会让冒烟**假绿**？
- 文档与实现是否一致：`docs/IPC-PROTOCOL.md` v1.6 的字段形状与 `main.cpp` 实际输出是否字面一致？

### C. 仍未闭环项

列出你发现的残留 P0/P1（含第一轮提过但未真正修掉的），附最小复现与建议修法。

## 7.4 已由主进程验证过的项（**不必重复验证**，但可质疑其充分性）

| 验证 | 结果 | 证据位置 |
|---|---|---|
| `m-verify -Level quick` | 全绿（fingerprint `9e278c9`） | 六步 PASS |
| M4 三冒烟（真核心） | `excl` / `expand` / `select` 全 PASS | `tools/m4-smoke/*.ps1` |
| C++ 策略状态机 | 35/35 | `tools/output-policy-test/run.sh` |
| `RhineCoreTests` / `RhineShell.Tests` | 34 / 8 | `dotnet test` |
| 前端单测 | settings 25、lrc 26、lyric-view 4、data 7、covers 12、library 4 | `node --test` |
| 真机 zip 解压验证 | `ZIP-CLEAN-VERIFY PASS`（`dist=C:\Users\StarL\zip-clean\web`） | 提交 `e9c5ec4` |

**质疑方向**：这些数字是否**覆盖了 6 笔修复的断言面**？例如——M4 P1-2 的"跟随默认恢复
自动重路由"有无任何测试真的断言到？若没有，指出"修复无自动化覆盖"本身就是有效意见（P2）。

## 7.5 不在本轮范围（明确排除，避免误开单）

- 物理交互验证：独占听感、拔 DAC、蓝牙耳机（需用户在场，主进程另行记录）。
- M4 未实现的既定功能：`volume.mode=integer`（定点位完美衰减）、`on_device_gone=pause`
  分支——这两项已**如实标记为未实现/占位**，不属缺陷。
- M0–M3/M5a/M6 的存量实现（除非上述 6 笔直接改动其行为）。
- 全仓代码风格、历史遗留清理。
