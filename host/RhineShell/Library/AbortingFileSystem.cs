using System.IO;
using TagLibSharp2.Core;

namespace RhineShell.Library;

/// <summary>
/// 带超时打断的文件系统包装（审查 P1-2）：TagLibSharp2 的 MediaFile.Read(path, IFileSystem)
/// 把 IO 全权交给注入的 fs——超时后 Dispose 本包装会关掉它正持有的 FileStream，
/// 让底层读抛 IOException 终止，消除"等待方超时返回、被等待方线程/句柄永久挂着"的泄漏。
///
/// 泄漏的真实代价（reviewer 实测推理，M5A-FINDINGS §11 采纳）：Scanner 用
/// MaxDegreeOfParallelism=4 的并行池 + 进程内 _busy 单例闸——4 个 hang 文件就能让
/// 一轮扫描永不收尾、_busy 恒 1、所有 library.* 写命令永久 library_busy。
///
/// 只读纪律（产品红线）：OpenReadWrite/Create/Delete/Move/WriteAllBytes* 一律抛
/// <see cref="NotSupportedException"/>——本应用永不写用户文件，若库内代码试图写会立刻暴露
/// 而不是静默破坏曲库。
/// </summary>
public sealed class AbortingFileSystem : IFileSystem, IDisposable
{
    private readonly object gate = new();
    private readonly List<FileStream> open = new();
    private bool disposed;

    public bool FileExists(string path) => File.Exists(path);

    public Stream OpenRead(string path)
    {
        // FileShare.ReadWrite：用户可能正用别的程序写标签；只读打开不干涉。
        var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite,
            16 * 1024, FileOptions.SequentialScan);
        lock (gate)
        {
            if (disposed) { fs.Dispose(); throw new IOException("scan aborted"); }
            open.Add(fs);
        }
        return fs;
    }

    public byte[] ReadAllBytes(string path) => File.ReadAllBytes(path);

    public Task<byte[]> ReadAllBytesAsync(string path, CancellationToken cancellationToken = default)
        => File.ReadAllBytesAsync(path, cancellationToken);

    public string? GetDirectoryName(string path) => Path.GetDirectoryName(path);

    public string GetFileName(string path) => Path.GetFileName(path);

    public string CombinePath(string path1, string path2) => Path.Combine(path1, path2);

    // —— 只读红线：写/删/移动一律拒绝（MediaFile.Read 路径不会调用它们）——

    public Stream OpenReadWrite(string path) => Throw("OpenReadWrite");

    public Stream Create(string path) => Throw("Create");

    public void WriteAllBytes(string path, ReadOnlySpan<byte> data) => Throw("WriteAllBytes");

    public Task WriteAllBytesAsync(string path, ReadOnlyMemory<byte> data, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("RhineLab-MusicPlayer never writes user media files");

    public void Delete(string path) => Throw("Delete");

    public void Move(string sourcePath, string destinationPath) => Throw("Move");

    private static Stream Throw(string member) =>
        throw new NotSupportedException($"read-only file system: {member} is not allowed");

    public void Dispose()
    {
        FileStream[] snapshot;
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            snapshot = open.ToArray();
            open.Clear();
        }
        foreach (var fs in snapshot)
        {
            try { fs.Dispose(); } catch { /* 打断用途：尽力关闭 */ }
        }
    }
}
