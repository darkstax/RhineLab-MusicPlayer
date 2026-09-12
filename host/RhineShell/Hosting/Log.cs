using System.IO;

namespace RhineShell.Hosting;

/// <summary>
/// M0 骨架的日志出口：一律追加到 <c>%LOCALAPPDATA%\RhineMusic\m0\logs\shell.log</c>，
/// 同时写 <see cref="System.Diagnostics.Debug"/>。日志只含链路与计数，绝不含任何凭据。
/// </summary>
public static class Log
{
    private static readonly object Gate = new();

    public static string Directory { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RhineMusic",
        "m0",
        "logs");

    private static string FilePath => Path.Combine(Directory, "shell.log");

    public static void Info(string message) => Write("info", message);

    public static void Warn(string message) => Write("warn", message);

    public static void Error(string message) => Write("error", message);

    private static void Write(string level, string message)
    {
        var line = $"[shell][{DateTime.Now:HH:mm:ss.fff}] {level} {message}";
        lock (Gate)
        {
            try
            {
                System.IO.Directory.CreateDirectory(Directory);
                File.AppendAllText(FilePath, line + Environment.NewLine);
            }
            catch (IOException)
            {
                // 日志失败不得影响启动路径
            }
            catch (UnauthorizedAccessException)
            {
                // 同上
            }
        }

        System.Diagnostics.Debug.WriteLine(line);
    }
}
