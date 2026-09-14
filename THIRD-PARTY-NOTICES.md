# THIRD-PARTY-NOTICES — 第三方组件与许可

> Rhine Lab Music Player（仓库 MIT，主版权人 StarL / darkstax）发行包与构建链所用第三方内容的
> 完整许可清单。**许可证文本以各组件上游仓库为准；本文件为署名与义务清单。**
>
> 机器节由 `node scripts/notices-check.mjs` 生成（nuget-license 4.0.17 + license-report 6.8.5），
> 校验规则：UNKNOWN=0、无 GPL/AGPL/LGPL 命中、diff 为空。手工节（vendor C 源件、字体、
> 宿主工具）由 lane F 按各包 LICENSE 实文维护。
>
> 生成物边界：只有随产品分发的运行时依赖进入 NuGet/npm 机器节；构建期工具
> （MSVC/MinGW、Inno Setup、CMake、Node/npm、Vite/TypeScript 工具链）不随包分发，在文末备案。

## 1. NuGet 依赖（.NET 壳 + 核心桩，含传递依赖）

产品运行时实际加载。全部 MIT / BSD-3-Clause / Apache-2.0。

<!-- BEGIN:NUGET -->

| Package                         | Version     | License Information Origin | License Expression | License Url                           | Copyright                                             | Authors      | Package Project Url                                     |
| --- | --- | --- | --- | --- | --- | --- |
| Microsoft.Data.Sqlite           | 10.0.12     | Expression                 | MIT                | https://licenses.nuget.org/MIT        | © Microsoft Corporation. All rights reserved.         | Microsoft    | https://docs.microsoft.com/dotnet/standard/data/sqlite/ |
| Microsoft.Data.Sqlite.Core      | 10.0.12     | Expression                 | MIT                | https://licenses.nuget.org/MIT        | © Microsoft Corporation. All rights reserved.         | Microsoft    | https://docs.microsoft.com/dotnet/standard/data/sqlite/ |
| Microsoft.Web.WebView2          | 1.0.4191.47 | File                       | BSD-3-Clause       | https://aka.ms/deprecateLicenseUrl    | © Microsoft Corporation. All rights reserved.         | Microsoft    | https://aka.ms/webview                                  |
| SQLitePCLRaw.bundle_e_sqlite3   | 2.1.12      | Expression                 | Apache-2.0         | https://licenses.nuget.org/Apache-2.0 | Copyright 2014-2024 SourceGear, LLC                   | Eric Sink    |                                                         |
| SQLitePCLRaw.core               | 2.1.12      | Expression                 | Apache-2.0         | https://licenses.nuget.org/Apache-2.0 | Copyright 2014-2024 SourceGear, LLC                   | Eric Sink    |                                                         |
| SQLitePCLRaw.lib.e_sqlite3      | 2.1.12      | Expression                 | Apache-2.0         | https://licenses.nuget.org/Apache-2.0 | Copyright 2014-2024 SourceGear, LLC                   | Eric Sink    |                                                         |
| SQLitePCLRaw.provider.e_sqlite3 | 2.1.12      | Expression                 | Apache-2.0         | https://licenses.nuget.org/Apache-2.0 | Copyright 2014-2024 SourceGear, LLC                   | Eric Sink    |                                                         |
| TagLibSharp2                    | 0.6.0       | Expression                 | MIT                | https://licenses.nuget.org/MIT        | Copyright (c) 2025-2026 Stephen Shaw and contributors | Stephen Shaw | https://github.com/decriptor/TagLibSharp2               |

<!-- END:NUGET -->

## 2. npm 依赖（前端运行时与构建）

`three` 与 `@kitlangton/rolling-number` 打进产品 bundle；`vite`/`typescript`/`prettier` 仅构建期。
全部 MIT / Apache-2.0。

<!-- BEGIN:NPM -->

| 包 | 版本 | 许可 | 作者 | 仓库 |
| --- | --- | --- | --- | --- |
| @kitlangton/rolling-number | 0.4.1 | MIT | Kit Langton | https://github.com/kitlangton/rolling-number.git |
| @types/three | 0.183.1 | MIT | n/a | https://github.com/DefinitelyTyped/DefinitelyTyped.git |
| prettier | 3.9.6 | MIT | James Long | https://github.com/prettier/prettier.git |
| three | 0.183.2 | MIT | mrdoob | https://github.com/mrdoob/three.js.git |
| typescript | 5.9.3 | Apache-2.0 | Microsoft Corp. | https://github.com/microsoft/TypeScript.git |
| vite | 7.3.6 | MIT | Evan You | https://github.com/vitejs/vite.git |

<!-- END:NPM -->

## 3. vendor C/C++ 源件（核心静态内联，手工节）

| 组件 | 版本 | 许可（按 LICENSE 实文） | 用途 | 署名义务与文本位置 |
|---|---|---|---|---|
| [miniaudio](https://github.com/mackron/miniaudio) | 0.11.25 | **Public Domain（Unlicense）/ MIT No Attribution 双许可，本项目选择 Public Domain**（`host/core/vendor/LICENSES/miniaudio-LICENSE.txt` ALTERNATIVE 1） | WASAPI 播放、解码（FLAC/MP3/WAV）、PCM 环、设备枚举 | 无（PD）；仍附许可文本于 `host/core/vendor/LICENSES/` |
| ├ 内嵌 dr_flac / dr_mp3 / dr_wav | （miniaudio 内联，mackron 维护） | 同 miniaudio（PD / MIT0 双许可） | 解码后端 | 同上 |
| ├ 内嵌 stb_vorbis | （miniaudio 内联，Sean Barrett） | Public Domain | OGG 面（本工程构建宏未启用解码扩展，仅头文件随单头分发） | 同上 |
| [kissfft](https://github.com/mborgerding/kissfft) | 1.3.1（vendor 快照） | **BSD-3-Clause**（按仓库 `COPYING` 实文：SPDX `BSD-3-Clause`；GitHub 元数据 NOASSERTION 不作数——任务书 §5 坑位已核） | 频谱 FFT（M3） | 保留版权声明与许可条款（`host/core/vendor/LICENSES/kissfft-COPYING.txt`、`kissfft-BSD-3-Clause.txt`） |
| [nlohmann/json](https://github.com/nlohmann/json) | 3.12.0 | MIT（`host/core/vendor/LICENSES/nlohmann-json-LICENSE.MIT.txt`） | IPC JSON 帧 | 保留版权声明（本表即署名载体，二进制分发随文档提供） |

## 4. 字体与品牌资源（仅上游网页/壁纸共用面，手工节）

| 组件 | 许可 | 说明 |
|---|---|---|
| [MiSans](https://mijoy.xiaomi.com/)（分包 `misans-webfont@4.3.1`，字体 4.003） | [小米 MiSans 字体许可](public/fonts/MiSans-license.pdf)（可商用免费，禁止再分发字体本体以外的限制性条款以许可原文为准） | 界面文字；分包来源与固定版本记录见 `verification/STARTUP-LOADING.md` |
| Novecento Sans Wide（Normal/DemiBold/Bold Webfont） | MyFonts 网页授权（**仅限本域名部署，不随产品包分发**；kit 不入 Git） | 开场中央文案；见 `verification/WEBFONT-DEPLOYMENT.md`、`verification/BOOT-LETTERING.md` |
| 原创三轨配乐 / 音效渲染 | 本项目程序编配（MIT），其中逐字输入使用的原 PV 三个 38ms 短音**不纳入 MIT 授权** | 见 `public/audio/README.md`、`verification/AUDIO-DESIGN.md` |
| 《明日方舟》/莱茵生命相关名称、标志、设定 | 鹰角网络及其权利人；本项目为非官方粉丝复刻，**不获任何再授权** | 见 README「开源许可」节 |

## 5. 构建期工具（不随包分发，仅备案）

| 工具 | 版本（lane F 实测锁） | 许可 |
|---|---|---|
| .NET SDK / MSVC Build Tools / CMake | 10.0.x / VS18 / ≥3.24 | Microsoft 免费分发许可（构建工具） |
| [Inno Setup](https://jrsoftware.org/isinfo.php) | 6.7.3（实测可用；7.x 兼容 iss） | [BSD 风格自有许可](https://jrsoftware.org/isphp/?c=news&t=license) |
| nuget-license（tomchavakis） | 4.0.17 | MIT |
| license-report | 6.8.5 | MIT |
| Node.js / npm / Vite / TypeScript / Prettier | Node ≥22.12；构建版本见上方 npm 节 | Apache-2.0 / MIT |

## 6. 义务总览

- MIT/BSD/Apache 组件：随分发保留版权与许可声明（本文件 + `LICENSE` + 各 vendor `LICENSES/`）。
- Apache-2.0（SQLitePCLRaw、TypeScript 构建链等）：无专利授权外附加义务；NOTICE 文件——上游包内无 NOTICE 强制项时不另造。
- Public Domain（miniaudio、dr_*、stb_*）：零义务，仍列明来源以示透明。
- MiSans 字体与 Novecento Webfont：按各自许可的域名/分发条款执行，不得并入本仓库 MIT 授权范围。
- 上游粉丝素材（明日方舟 IP）：见 README——本项目代码的 MIT 授权不覆盖原作权利。
