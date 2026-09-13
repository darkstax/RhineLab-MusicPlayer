; Rhine Lab Music Player — Inno Setup 安装器脚本（M6）
; 由 scripts/package.ps1 调用：ISCC /Qp /DAppVersion=x /DStageDir=y /DOutDir=z rhine.iss
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
Name: "chinesesimplified"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"
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
var
  paths: array of String;
  i: Integer;
begin
  // 任一 sharedfx 键存在即视为已装 10.x Desktop Runtime（版本子键枚举代价高，交给运行时自证：
  // 真缺时壳根本起不来，README 已写明前置）。
  Result := False;
  paths := CreateArray(
    'SOFTWARE\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App',
    'SOFTWARE\WOW6432Node\dotnet\Setup\InstalledVersions\x64\sharedfx\Microsoft.WindowsDesktop.App',
    'SOFTWARE\dotnet\Setup\InstalledVersions\x86\sharedfx\Microsoft.WindowsDesktop.App');
  for i := 0 to GetArrayLength(paths) - 1 do
    if RegKeyExists(HKLM, paths[i]) or RegKeyExists(HKCU, paths[i]) then Exit(True);
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
