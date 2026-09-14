# M4 任务书：独占模式 + 协商状态机 + 降级链 + 热插拔（主进程亲自实施，用户在场所需交互）

> 09-14 用户在场窗口解锁（此前排除自主循环正是因为它交互密集）。
> 设计权威：AUDIO-ENGINE §7.2（协商/降级链）、§5/§6（音量/缓冲）、Q7=keep、Q1-c=升档封顶 300ms。
> 已实测硬件底数（§23）：USB DAC 独占 16/24bit @44.1k–384k 全通过、minPeriod=3ms、
> float32 独占全设备不支持（整型容器硬约束）、Realtek ≤192k、Steam 虚拟仅 16bit。
> miniaudio 能力：`ma_share_mode_exclusive`、`MA_DATA_FORMAT_FLAG_EXCLUSIVE_MODE` 能力位、
> device notification（rerouted/interruption_began/ended）、context onDeviceChange（IMMNotificationClient 内置）。

## 范围拆分（每段独立可验，交互步骤标注）

### M4-a 独占开路（核心）
- `output.mode {mode:"shared"|"exclusive"|"auto", buffer_ms?, auto_expand_buffer?, buffer_max_ms?}`
  从 not_implemented 转正：重开流协商（stop→close→initialize(EXCLUSIVE, 事件式, 源格式
  i16/i24-in-i32 @源率)→start→对齐续播）。
- 协商状态机（§7.2）：请求独占 → `IsFormatSupported` 预探测 → 失败分类（busy/格式不支持/
  buffer<min）→ 按 fallback_order 降级 shared-event + `evt.error{degraded_to}` + 诊断时间线记录。
- FidelityAssessor 升级：独占 ∧ 整型 ∧ 无 SRC ∧ fixed 音量 → `fidelity:"bit-perfect"`、
  badges.exclusive=true（**共享模式恒 app-perfect 封顶的现状不变**）。
- 音量联动：独占下 hardware 模式不可用（无端点会话音量）→ 自动切 fixed 并 ack 说明；
  float 音量在独占=非位完美，徽章如实降级。
- 【交互①】用户切独占 → 播放 FLAC：听是否出声、看徽章变 BIT-PERFECT、开音乐fox/系统声
  确认"其他应用被 Windows 切走或静音"（keep 语义）。

### M4-b 降级链 + 自动升档 + 恢复
- underrun 滑动窗口 ≥N → buffer 自动升档（min→5→10→25→50→100→300ms 封顶，
  `auto_expand_buffer=false` 或 `buffer_max_ms` 可锁）；写降级时间线 + UI 明示。
- 独占被外部抢占（设备端报错/断流）→ 被动降级共享，后台 5s 探测独占可恢复性，
  **曲间间隙静默升回**（不打断当前曲）或用户点"立即恢复"。
- 【交互②】独占播放中强开第二个独占请求者（foobar/另一实例）→ 验证不让位（keep）+
  对方失败或切设备；释放后探测升回。
- 【交互③】（可选）制造 underrun：高负载（大文件拷贝）下听爆音/看升档日志。

### M4-c 热插拔与设备切换
- context onDeviceChange：默认设备变更 ∧ 用户设 default 跟踪 → 平滑迁移（重开+续播）；
  当前设备拔出 → 暂停 + `evt.error{device_gone}` + 自动切系统默认（`on_device_gone` 策略）。
- `devices.select {id, mode}`：手动切设备（暂停→关旧→开新→恢复+对齐）；
  devices.list 的 capabilities 补 exclusive 真实探测（IsFormatSupported 批量缓存，
  三态标签：独占24bit / 独占16bit / 无独占——防误配虚拟设备/蓝牙的既定设计）。
- 【交互④】播放中拔 USB DAC → 确认暂停+提示+自动切实卡续播（或按配置暂停）；插回 → 切回。
- 【交互⑤】蓝牙耳机（若有）：连接后 devices.list 显示"无独占"、选它播放出声、徽章如实
  app-perfect；断开回退。

### M4-d UI/协议收口
- 协议 v1.6：output.mode/devices.select 转正（去 M4 标记）、`evt{diag}` 的 buffer 升档事件、
  negotiated.share 可为 exclusive。桩同步假数据（exclusive 徽章路径可测）。
- 设置（lane E 已落地的输出组）：模式三态 + 缓冲策略 + 恢复策略开关；信号路径图
  显示 EXCLUSIVE 段（绿）；常驻"独占中·其他声音可能不可闻"角标（Q7 keep 的明示纪律）。
- WE/壁纸构建不受影响（无核心）。

## 停点与验收门槛
- 每段：m-verify quick 绿 + 对应交互步骤用户口头确认（记 FINDINGS"用户实测 YYYY-MM-DD HH:MM"）。
- 硬件矩阵四场景（内置/DAC/蓝牙/虚拟）逐项记录进 docs/M4-FINDINGS.md（模板在 win-audio-probe 输出基础上人工补）。
- underrun 长跑：独占 + 自动升档开启跑 30min 后台采样（不打扰用户），结果进 FINDINGS。

## 实施顺序与协调
1. 等 laneF 完成（它正改 audio.cpp/main.cpp 的 diag 只读面——**同文件，先合它再动**）。
2. M4-a → 交互① → M4-b → 交互②③ → M4-c → 交互④⑤ → M4-d → 长跑 → 审查（这次 reviewer
   可以后置到全部完成后一次做，因为交互验证比静态审查更强）。

## 风险登记
- 独占重开流的"跳静音"：衔接 2ms 淡入（§7.3 已定，徽章不降级的例外口径写死注释）。
- 探测独占的副作用：探测=尝试 open，可能闪断对方音频——**只在曲间间隙/暂停时探测**，
  不在对方播放中主动骚扰（keep 是"我占着不让"，不是"我抢别人的"）。
- 蓝牙 A2DP 在 Windows 上通常枚举不到独占（预期内），若某耳机支持则按能力矩阵如实显示。

## 实施记录（主进程，09-14）

### M4-a ✅（代码+机制验证完成；听感=交互点①待用户）
- OutputPolicy 纯逻辑 harness 35/35；接线中发现并修两真 bug：
  ① succeed() 用 current_=out 抹掉 Note 累积的 timeline（账本改独立成员持久化）；
  ② auto 落 shared 漏记 degraded（判定改"请求非 shared 而达成 shared 即降级"）。
- **枚举表陷阱（excl-probe 实测）**：miniaudio WASAPI 枚举不填 nativeDataFormats
  （三端点全 formats=0）→ ExclusiveCapable 预探测永假 → 改"试开即探测"
  （ReopenForTrack 直接 ma_device_init(EXCLUSIVE)，失败降级——恰是 §7.2 语义）；
  devices.list.exclusive 三态化（null=未知/已开=实况/有表=探测），协议 v1.6。
- SetOutputMode 自查修正：Freeze+Reopen 会让 decoder 输出率与新设备脱节（音高/位置错位）
  → 改 CloseTrack→OpenTrack 完整重建链（decoder 按新 appRate 重建），失败路径对齐 Play 清理。
- 默认值纪律：OutputPolicyConfig.mode 默认 **Shared**（§15"独占绝不默认开"；
  初版默认 Auto 会在首播静默抢独占，自查修正）。
- 结果形状统一：output.mode ack = {negotiated:{...}}（协议表字面嵌套，桩/真核心一致；
  冒烟脚本两次踩平铺/嵌套分歧后对齐）。
- 验证：excl-smoke 双模 PASS（真核心 exclusive→bit-perfect factors=[]、exclusive↔shared
  往返位置连续 4080→4120；桩假协商注入 state 快照生效）；diag-smoke v1.6 三态断言双模 PASS；
  smoke.ps1 PASS；m1-scenario 桩裁判 ALL PASS；m-verify quick -NoCache 六步全绿。
- 桩假数据：假设备矩阵 exclusive 按 §23 实测档（DAC 8 档 16/32、Realtek 6 档、Steam 仅 16）；
  FakeEngine.FakeNegotiated 注入点（不调 output.mode 时保持 M1 豁免 null，裁判断言不破）。

### M4-b ✅（升档/恢复探测，09-14）
- Engine 挂点：Tick 每拍喂 MaybeExpandBuffer（underrun 增量→OnUnderrun 滑窗→触发则
  RebuildChain 续播，事件并回本 tick）+ MaybeRecoverExclusive（只在非 playing 时机走
  ProbeDue 节奏，RebuildChain 试开即探测；绝不打断当前曲——keep 语义的"不抢别人"半边）。
- ReopenForTrack 改走 OutputPolicy::Negotiate 正规路径（fallback_order × BufferTooSmall
  抬升重试一次再降级）——expand-smoke 抓到 buffer_ms=5 直落 shared 的缺口后收编。
- buffer_ms 语义修正：negotiated.buffer_ms = 策略管理缓冲（policy.bufferMs()），
  不再用设备 internalPeriod×periods（独占大请求下 miniaudio 读数异常放大 300→2612ms，
  位置推进不受影响 = 显示语义问题；设备节奏归 period_ms）。
- dev-inject 钩子（--dev-inject stdin："underrun N"/"exit"）：升档路径的确定性机器验证，
  生产默认关闭零行为变化。
- 验证：expand-smoke 双模 PASS——SHARED（标志生效+位置连续+策略缓冲 5→10）、
  EXCL（play 后 share=exclusive fidelity=bit-perfect、升档 5→10→…→300 封顶、
  高频升档长曲仍 playing、bye exit 0）；excl-smoke 回归 PASS；m-verify quick 六步全绿。

### M4-c ✅（热插拔 + 设备切换，09-14）
- devices.select 启用（协议 v1.6）：id 空=回跟随系统默认；非空=钉选（枚举校验，未知 bad_request）；
  有曲时 RebuildChain 完整重建续播（位置不回退）。
- 设备事件双路：miniaudio notificationCallback（rerouted/interruption，通知线程只置原子旗）
  + 会话 tick 轮询兜底（钉选设备拔出无默认变更通知 → playing 却 !device_running 判失效）。
- 失效处理：先自动重开（跟随默认则切新默认）；失败 → 收敛 paused + evt{error,device_gone,
  retryable}（协议 v1.6 新 kind）；非 playing 忽略（下次 play 自然对齐）。
- 共享模式 miniaudio 内置自动重路由（vendor 源码确认；独占不自动=已知限制，走我们的重开路径）。
- 验证：select-smoke PASS（真机 USB DAC→Realtek 钉选切换、续播位置 2025→2090 连续、
  未知 id 拒绝、失败后链无损）；expand-smoke 3/3 稳定 PASS（新发现：跨进程独占 drain
  窗口致偶发 device-busy，脚本会话间 +2s 隔离——真实产品里壳只拉一个核心，无此路径）；
  excl-smoke 回归 + policy harness 35/35 + m-verify quick 六步全绿。
- 交互④（拔 DAC）/⑤（蓝牙耳机）仍待用户物理验证（脚本无法代劳）。
