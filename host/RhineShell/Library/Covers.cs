using System.IO;
using System.Security.Cryptography;

namespace RhineShell.Library;

/// <summary>
/// 封面抽取与内容寻址存储（协议 v1.4 §5.1：covers/&lt;sha1 冒号换横杠&gt;.&lt;ext&gt;，
/// WebView2 虚拟主机 cover.rhine.local 直读，零 IPC 载荷）。
///
/// 铁律：**只读用户文件**——封面字节写进我们自己的 covers 目录，永不写回音频容器。
/// 解码失败/非法图像由 Scanner 记 quarantine（M5-PLAN-v2 §7.2）。
/// </summary>
public static class Covers
{
    public static string Directory => System.IO.Path.Combine(LibraryDb.Directory, "covers");

    /// <summary>cover_key（"sha1:&lt;hex&gt;"）→ 虚拟主机 URL 文件名段（§5.1：冒号换横杠）。</summary>
    public static string FileStem(string coverKey) => coverKey.Replace(':', '-');

    /// <summary>写入封面并返回 cover_key（"sha1:&lt;hex&gt;"）。同内容天然去重（存在即跳过）。
    /// 扩展名按魔数（jpg/png/webp/gif），未知按 jpg（创意工坊/浏览器按图片魔数解码，扩展名只做人眼可读性）。</summary>
    public static string Put(byte[] data)
    {
        var hex = Convert.ToHexStringLower(SHA1.HashData(data));
        var stem = $"sha1-{hex}";
        var ext = SniffExtension(data);
        var path = System.IO.Path.Combine(Directory, stem + ext);
        if (!File.Exists(path))
        {
            System.IO.Directory.CreateDirectory(Directory);
            // 原子写：tmp + move（并发扫描同 key 时避免半文件）
            var tmp = path + $".{Environment.ProcessId}.tmp";
            File.WriteAllBytes(tmp, data);
            File.Move(tmp, path, overwrite: true);
        }
        return "sha1:" + hex;
    }

    private static string SniffExtension(byte[] d) =>
        d.Length switch
        {
            >= 3 when d[0] == 0xFF && d[1] == 0xD8 && d[2] == 0xFF => ".jpg",
            >= 8 when d[0] == 0x89 && d[1] == 0x50 && d[2] == 0x4E && d[3] == 0x47 => ".png",
            >= 12 when d[0] == 'R' && d[1] == 'I' && d[2] == 'F' && d[3] == 'F'
                       && d[8] == 'W' && d[9] == 'E' && d[10] == 'B' && d[11] == 'P' => ".webp",
            >= 3 when d[0] == 'G' && d[1] == 'I' && d[2] == 'F' => ".gif",
            _ => ".jpg",
        };
}
