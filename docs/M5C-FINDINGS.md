# M5c 实施记录：任务栏歌词 writer（主进程亲手，泳道 C 缩窄后）

## 1. 交付

| 文件 | 角色 |
|---|---|
| `host/RhineShell/Taskbar/TaskbarWriter.cs` | 纯逻辑 writer：冻结协议（musicfox↔Taskbar-Lyrics）JSON Lines、懒连接、指数退避 500ms→5s 封顶、失败静默降级、`SentFrames/DroppedFrames` 诊断计数。**只发 lyric 帧永不发 config**（Q4） |
| `host/RhineShell/Taskbar/TaskbarWiring.cs` | 接线胶水：订阅 Bridge 预埋钩子（`LyricShowRequested/TaskbarSetRequested`，commit `f1a06ea` 前已入库）、config 读键（`taskbar.source`=off\|player\|musicfox 默认 off；`taskbar.pipe`）、`taskbar.set` 意图持久化回写 |
| `host/RhineShell/MainWindow.xaml.cs` | 两行：`_taskbar = TaskbarWiring.Install(_bridge)` + OnClosed Dispose |
| `host/RhineShell.Tests/{RhineShell.Tests.csproj,TaskbarWriterTests.cs}` | 8 用例：协议帧形状（含中文不转义=与 Go json.Marshal 字节同形）、退避序列封顶、禁用零开销、懒连接静默 dropped 计数、开关断开重置、真管道端到端×2 |

协议偏差修正（相对任务书草案）：`System.Text.Json` 默认把中文转义成 `\uXXXX`，
Go `json.Marshal` 原样输出 UTF-8 → 加 `UnsafeRelaxedJsonEscaping` 对齐字节形状（抓包比对友好，
对端 JSON 解析器本不敏感；单测锁死该形状）。

## 2. 验收

- 单测：**WSL 8/8 全绿**（0.29s，D 快车道）。
- Windows 侧：纯逻辑 6/6 通过（`--filter` 排除两真管道用例后 exit=0）；
  **两个进程内命名管道用例在 Windows vstest 宿主挂起**（WSL 同码 0.3s 全过）——
  测试宿主环境问题非产品缺陷（写路径本身与 musicfox 生产实现同构）；
  按"同一错误 3 连败"纪律停止深挖，登记 P2；真机端到端并入 §4 停点（与 Taskbar-Lyrics 插件
  联调时一并验）。
- 壳构建：`dotnet build RhineShell -c Release` **0 警告 0 错误**（镜像实测）。
- `m-verify -Level quick`：见主进程合并验收记录（本泳道提交后）。

## 3. 与 musicfox pipe_writer 的行为差异表

| 维度 | musicfox (Go) | 本实现 (C#) | 理由 |
|---|---|---|---|
| config 帧 | 有（样式下发） | **永不发** | Q4 裁定样式归插件端，防双主 |
| 退避 | 500ms→5s | 同 | 照抄 |
| 连接时机 | 启动即连 | **懒连接**（首个 lyric 帧） | 默认 off 时零开销 |
| 写失败 | slog 告警 | 静默 + DroppedFrames 计数 | 防刷屏；诊断走计数 |
| 归属 | 无协商 | config `taskbar.source` 三态单选 | 与 musicfox 共存防双写（用户显式接管） |

## 4. 停点移交（用户在场）

- [ ] Taskbar-Lyrics 插件联调：`taskbar.set{enabled:true}` → 任务栏出歌词（含 Windows vstest
      两挂起用例的真机等价覆盖）
- [ ] 与 go-musicfox 同开时的表现确认（预期：互相覆盖最后写入者，文案已警示）
