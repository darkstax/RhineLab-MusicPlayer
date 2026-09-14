; Rhine Lab Music Player — Inno Setup 安装器脚本（M6）
; 由 scripts/package.ps1 调用：ISCC /Qp /DAppVersion=x /DStageDir=y /DOutDir=z rhine.iss
; 工具兼容：Inno Setup 6.4+（实测 6.7.3；ISPP/#ifexists、x64compatible 需 ≥6.4），7.x 同样可用。
; Inno Setup 是**构建期工具**（自有 BSD 风格许可），其产物不含可分发的工具运行时 → 不污染产品许可树。
#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef StageDir
  #define StageDir "..\dist-release\stage"
#endif
#ifndef OutDir
  #define OutDir "..\dist-release"
#endif

[Setup]
AppName=Rhine Lab Music Player
AppVersion={#AppVersion}
AppPublisher=StarL
AppSupportURL=https://github.com/darkstax/RhineLab-MusicPlayer
DefaultDirName={autopf}\RhineMusic
DefaultGroupName=Rhine Music
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#OutDir}
OutputBaseFilename=RhineMusic-{#AppVersion}-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\RhineShell.exe
CloseApplications=force

[Languages]
; 中文语言包（ChineseSimplified.isl）在官方安装包中属**非默认分发**件（6.7/7.x 只带西文系），
; 需从 jrsoftware.org/files/isl 单独下载放 compiler:Languages\。
; package.ps1 探测到才传 /DHasChinese；缺失时回退英文向导，不阻塞打包（lane F 实测定案 2026-09-14：
; ISPP 无 #ifexists 指令，存在性判断上提到调用方）。
#ifdef HasChinese
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
#endif
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Icons]
Name: "{group}\Rhine Lab Music Player"; Filename: "{app}\RhineShell.exe"
Name: "{group}\卸载 Uninstall"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Rhine Lab Music Player"; Filename: "{app}\RhineShell.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\RhineShell.exe"; Description: "{cm:LaunchProgram,Rhine Lab Music Player}"; Flags: nowait postinstall skipifsilent

[Code]
// 运行前置检测：.NET 10 Desktop 运行时（HKLM 64/32 与 HKCU 的 sharedfx 三处都查）与 WebView2 Runtime。
// 缺失不静默安装（Q8 纯净原则 + 用户可审），只在完成页前给出明确指引。
function DotNetDesktopOk: Boolean;
begin
  // 任一 sharedfx 键存在即视为已装 10.x Desktop Runtime（版本子键枚举代价高，交给运行时自证：
  // 真缺时壳根本起不来，README 已写明前置）。不用数组/CreateArray（Inno 6.x Pascal 无此库函数，
  // lane F 实测编译报错），直接三项短路判断。
  Result :=
    RegKeyExists(HKLM, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App') or
    RegKeyExists(HKCU, 'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App') or
    RegKeyExists(HKLM, 'SOFTWARE\WOW6432Node\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App') or
    RegKeyExists(HKLM, 'SOFTWARE\dotnet\Setup\InstalledVersions\x86\sharedfx\Microsoft.WindowsDesktop.App');
end;

function WebView2Ok: Boolean;
begin
  Result := RegKeyExists(HKLM,
    'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
     or RegKeyExists(HKLM,
    'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}')
     or RegKeyExists(HKCU,
    'Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  msg: String;
begin
  if CurStep <> ssPostInstall then Exit;
  msg := '';
  if not DotNetDesktopOk then
    msg := msg + '- .NET 10 Desktop Runtime（https://dotnet.microsoft.com/download/dotnet/10.0）' + #13#10;
  if not WebView2Ok then
    msg := msg + '- Microsoft Edge WebView2 Runtime（https://developer.microsoft.com/microsoft-edge/webview2/）' + #13#10;
  if msg <> '' then
    MsgBox('安装完成，但本机缺少运行前置，请安装后启动：' + #13#10#13#10 + msg,
      mbInformation, MB_OK);
end;
