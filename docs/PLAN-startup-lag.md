# 计划：消除启动时的数秒卡顿（水合阻塞首帧）

> 状态：**待实施**（本文件仅为计划，未改任何代码）
> 现象（用户实测）：进入主界面后**严重卡顿数秒**才恢复
> 侦察日期：2026-09-16 · 基线 HEAD：`73a4493`

---

## 1. 根因（已定位，附证据）

### 1.1 卡顿发生在哪

`src/main.ts:1445`：

```ts
async function start() {
  await wallSession.hydration;      // ← 阻塞点：首帧前必须等水合完成
  await albumWall.loadConfig();
  rebuildColumnMemory();
  updateSelection();
  scene = new ArchiveScene($("#three-scene"));   // ← 三维场景在*这之后*才建
  await Promise.all([scene?.load(), loadBootWebfonts(), ...]);
```

`wallSession.hydration` 在 `src/m1-mount.ts:27` 赋值，其内容是 `hydrateFromLibrary(bridge)`。

**关键**：三维场景、字体、阵列数据的启动全被这一行 `await` 串住。水合多久，白屏/卡顿就多久。

### 1.2 水合为什么慢

`src/data.ts:202 collectAlbums()` 是**串行**分页爬取：

```ts
const base = await fetchAlbums(source, {});          // 1 次（limit 200 → 只覆盖前 200 张）
for (let guard = 0; queue.length > 0 && guard < 400; guard++) {
  const genre = queue.shift()!;
  const page = await fetchAlbums(source, { genre }); // 每流派 1 次
  if (page.total > page.items.length) {
    for (let year = 1970; year <= thisYear + 5; year++) {
      const slice = await fetchAlbums(source, { genre, filter: { year } }); // ← 逐年切片
    }
  }
}
```

每次 `fetchAlbums` = 一次**完整 IPC 往返**（命名管道 → C# 壳 → SQLite 查询 → JSON 序列化 → 回传）。

**按用户真实曲库估算**（`docs/M5A-FINDINGS.md`：1116 曲 / **344 专辑** / **13 流派**，Arknights 单列 290 张）：

| 来源 | 次数 |
|---|---|
| 基线全量 | 1 |
| 各流派分页 | ~13 |
| 超 200 的列（Arknights 290 张）逐年切片 | 1970–2031 = **62** |
| 其它溢出列（若有） | 0–62 |
| **合计** | **40–80+ 次串行往返** |

每次往返含 SQLite 聚合 + 344 行的 DTO 序列化 → 累计数秒，与用户体感吻合。

### 1.3 次生问题

- 水合期间**界面无反馈**（boot 已结束但场景未建）→ 用户看到"卡住"
- 逐年切片是**为绕开 limit 200 的补丁**，本身是权宜设计（见 `data.ts:227` 注释）

---

## 2. 方案对比

### 方案 A：核心/壳侧新增"一次性全量专辑"接口（**推荐**）

**做法**：壳的 `library.albums` 增加 `limit: 0`（= 不限）或新增 `library.albums.all`，
一次返回全部 344 张专辑（DTO 约 344 × ~200B ≈ 70KB，管道完全吃得下）。

- 前端 `collectAlbums` 简化为**一次调用**（或保留分页作兜底）
- 往返次数：40–80+ → **1**

**优点**
- 改动小（壳加一个分支、前端删循环），**风险低**
- 保留现有协议形状（同一命令、同一 DTO），只放开上限
- 顺带消灭"逐年切片"这个权宜补丁

**缺点**
- 需确认 `library.albums` 的实现是否已支持 `limit` 参数放开（**待查**：`LibraryApi.cs` 的 `Albums`）

**工作量**：壳 ~20 行 + 前端 ~30 行 + 测试。**预计 1–2 小时**。

### 方案 B：不阻塞首帧（**建议与 A 并行**）

**做法**：把 `await wallSession.hydration` 从关键路径移开：

1. 三维场景**先用演示数据/空阵列**建起来并渲染首帧
2. 水合完成后**原地 splice 填充**（`data.ts` 已经是 in-place 语义）
3. 期间显示轻量提示（如阵列处一行"正在索引本地曲库…"）

**优点**
- **用户感知彻底消失**：无论水合多慢，界面立刻可用
- 与 A 正交，可叠加

**缺点**
- 需处理"填充前用户就已操作"的边界（点空阵列、搜索无结果）
- `rebuildColumnMemory()` 需在水合后重跑（已在 `:1447`，顺序要重排）

**工作量**：~40 行 + 状态处理。**预计 2–3 小时**。

### 方案 C：并行化分页请求

前端 `Promise.all` 并发拉各流派。

**缺点**：IPC 是**单管道串行**（`ShellChannel` 单连接），并发发帧也只是排队；且会把 SQLite 压力集中。
**结论**：**不推荐**（治标不治本，A 做完后无意义）。

### 方案 D：壳侧缓存水合结果

壳把专辑列表缓存到磁盘，启动时直接返回。

**缺点**：引入缓存失效问题（曲库变了要重建），复杂度高。
**结论**：**暂不做**（A+B 足够；若将来曲库到万张级再考虑）。

---

## 3. 推荐路线：**A + B 叠加**

| 阶段 | 内容 | 效果 |
|---|---|---|
| 1 | 方案 A（一次拉全量） | 卡顿从"数秒"降到"百毫秒级" |
| 2 | 方案 B（不阻塞首帧） | 卡顿**感知归零** |

只做 A 也能解决 90% 的问题；B 是体验上的"保险"。

---

## 4. 实施步骤（供后续 agent 直接执行）

### 阶段 1：方案 A

1. **查壳**：`host/RhineShell/Library/LibraryApi.cs` 的 `Albums(id, data)` 分支
   - 确认 `limit` 如何解析、是否有硬上限
   - 加 `limit <= 0` → 不限（或设一个安全上限如 5000）
   - **注意**：不要改 SQL 语义，只放开 LIMIT 子句

2. **改前端**：`src/data.ts`
   - `fetchAlbums(source, {})` 改为一次拉取足量（如 `limit: 0`）
   - 保留现有分页循环作为**兜底**（当 `total > items.length` 时才走），避免旧壳不兼容
   - 删除或保留逐年切片均可（A 生效后不会触发）

3. **桩同步**：`host/RhineCoreStub` 若也实现 `library.albums`，需同步（否则桩环境行为不一致）

4. **测试**：
   - `src/data.test.mjs` 加断言：单次调用即拿到全部专辑（mock source 记录调用次数）
   - 断言"调用次数从 N 降到 1"

### 阶段 2：方案 B

5. **改 `src/main.ts:1441 start()`**：
   ```ts
   // 先建场景（不 await 水合）
   scene = new ArchiveScene($("#three-scene"));
   await Promise.all([scene?.load(), loadBootWebfonts(), ...]);
   // 水合在后台推进；完成后回填 + 重建列记忆
   wallSession.hydration.then(() => { rebuildColumnMemory(); updateSelection(); });
   ```
   - 顺序敏感的项（`rebuildColumnMemory`/`updateSelection`）必须移到水合回调里
6. **加加载态**：水合未完成时给个轻提示（不阻塞操作）
7. **边界**：水合完成前用户点击阵列/搜索 → 不崩、给空态

### 阶段 3：验证

8. **量化**（必须实测，不接受"感觉快了"）：
   - 用 CDP 打点：`performance.mark` 在水合前后，读 `performance.measure`
   - 断言水合耗时 & 首帧时间
9. **回归**：`m-verify -Level full` 10 步全绿 + 两个 CDP 守护（`check-boot-health` / `check-player-layout`）
10. **真机**：让用户确认"进入后不再卡"

---

## 5. 风险与注意事项

| 风险 | 说明 | 缓解 |
|---|---|---|
| 全量返回体积 | 344 张 @ ~200B ≈ 70KB；若将来上万张会到 MB 级 | 设安全上限（如 5000）+ 保留分页兜底 |
| 旧壳不兼容 | 用户若不更新壳只更新前端 | 分页循环保留为兜底（已含在步骤 2） |
| 顺序依赖 | `rebuildColumnMemory` 必须在数据就位后跑 | 阶段 2 明确搬到水合回调 |
| 桩/真核心行为差异 | 桩可能没实现 `library.albums` | 步骤 3 同步；桩环境已有 hydrate 失败回退 |
| 上游零侵入 | `data.ts`/`main.ts` 是自家前端，**可改**；`host/core/**` 不该动 | 方案 A 只碰 C# 壳，不碰 C++ 核心 |

---

## 6. 验收标准

- [ ] 水合 IPC 往返次数：**≥40 → 1**（用 mock 单测断言调用次数）
- [ ] 首帧时间不受水合影响（方案 B 后）
- [ ] 用户真机确认"进入后无明显卡顿"
- [ ] `m-verify -Level full` 全绿；两个 CDP 守护 PASS
- [ ] 协议无破坏性变更（`library.albums` 仅放开 `limit` 语义）

---

## 7. 若只想快速止血

**最小改动**：只做阶段 1 的步骤 1+2（放开 limit + 一次拉全量），**跳过阶段 2**。

预计把"数秒卡顿"压到"几百毫秒"，用户多半已满意；若仍觉卡，再上阶段 2。
