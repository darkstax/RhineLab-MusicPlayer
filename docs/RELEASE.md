# 发布流程（M6 终稿）

> 状态：**发布 = 手动 GitHub Releases**（Q8 定案，updater 不做，仅留占位）。
> 本文件是发布操作的对客清单；构建与产物验证的实测证据见 `docs/M6F-FINDINGS.md`。

## 1. 前置

### 构建机
- Windows 11 + .NET SDK 10 + VS Build Tools（C++）+ CMake ≥3.24
- Node.js ≥22.12（前端构建 + `scripts/notices-check.mjs`）
- **Inno Setup 6.4+ / 7.x**（仅 exe 安装器需要；构建期工具，永不进产品包）
  - 推荐：`winget install JRSoftware.InnoSetup`（无管理员时落
    `%LOCALAPPDATA%\Programs\Inno Setup 6\`，`package.ps1` 已覆盖该查找路径）
  - 中文向导语言包是官方非默认分发件：从 <https://jrsoftware.org/files/isl/> 下载
    `ChineseSimplified.isl` 放入 `<Inno目录>\Languages\`；缺失时安装器自动回退英文向导（`#ifexists` 守卫）。
  - 缺 ISCC 时 `package.ps1` 只出 zip 并 WARN，不阻塞。

### 目标机（用户）
- Windows 10/11 x64
- .NET 10 Desktop Runtime（<https://dotnet.microsoft.com/download/dotnet/10.0>）
- WebView2 Runtime（Win11 自带；Win10 见 <https://developer.microsoft.com/microsoft-edge/webview2/>）
- exe 安装器在安装完成页检测上述两项，缺失时给出下载指引（不静默安装——Q8 纯净原则）；
  zip 便携版由包内 `README-portable.txt` 说明。

## 2. 打包（一次命令）

```powershell
pwsh -NoProfile -File scripts\m-build.ps1        # 壳 + 桩 + 前端（零警告线）
pwsh -NoProfile -File scripts\m2-build.ps1      # C++ 核心 RhineCore.exe
pwsh -NoProfile -File scripts\package.ps1       # staging → zip + exe → dist-release\ + SHA256
```

产物（`dist-release/`，不入库）：
- `RhineMusic-win-x64-<ver>.zip` — 便携版
- `RhineMusic-<ver>-x64-setup.exe` — Inno 安装器（每用户安装，`PrivilegesRequired=lowest`）

版本号单一源 = `version.json`（壳 csproj FileVersion / iss `AppVersion` / 前端 about 共读）。

## 3. 发布前检查清单（每次发布必跑）

| # | 检查 | 命令 / 断言 |
|---|------|-------------|
| 1 | 全量验证 | `pwsh scripts/m-verify.ps1 -Level full -NoCache` 退出码 0 |
| 2 | 只读数据面冒烟 | `pwsh tools/m6-smoke/diag-smoke.ps1`（真核心）+ `-Stub` 各一遍 PASS |
| 3 | 合规 | `node scripts/notices-check.mjs` 退出码 0（UNKNOWN=0、diff 空） |
| 4 | zip 解压冒烟 | `Expand-Archive` 到干净目录 → 起壳 → 握手 → 播放断言（见 RELEASE §5 停点） |
| 5 | LICENSE 头 | `Copyright (c) 2026 StarL / darkstax` + MIT 正文逐字节 |

## 4. GitHub Releases 操作（手动，停点）

1. `git tag v<ver> && git push upstream v<ver>`（push = 停点，需用户执行/授权）
2. 在 <https://github.com/darkstax/RhineLab-MusicPlayer/releases> 新建 Release：
   - 上传 zip + exe 两产物，正文贴 **SHA256**（`package.ps1` 末尾输出）
   - 变更摘要、已知问题（下方 §5）
3. 无代码签名 → SmartScreen「未知发布者」提示属预期，Release 说明中预告。

## 5. 发布前待用户动作 / 已知停点

- **听感验收**：玻璃交互、逐字输入音、三轨配乐——技术验证不代表听感定案。
- **蓝牙耳机场景**：A2DP 能力矩阵待补测（AUDIO-ENGINE §23）。
- **Taskbar-Lyrics 联调**：任务栏歌词管道端到端与用户插件实机联调。
- **exe 安装-卸载实机演练**：`/VERYSILENT /PORTABLE=1` 装到 TEMP → 开始菜单项 → 卸载残留检查
  （本轮 lane F 仅完成构建打包与 iss 校验；静默装演练随主进程合并阶段执行）。
- **updater**：不做（占位：设置页「检查更新」仅打开 Releases 页）。
- **SmartScreen**：无签名提示——文案在 Release 正文说明即可，不购买证书（本地私有项目）。
