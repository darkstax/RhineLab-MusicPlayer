using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using RhineShell.Hosting;
using TagLibSharp2.Core;

namespace RhineShell.Library;

/// <summary>
/// 曲库扫描器（M5-PLAN-v2 §4.1/§4.2/§7.2；自研编排 ~250 行，选型见 §1.1）。
///
/// 流水线：并行枚举 roots（config <c>library.roots</c>，默认 <c>C:\Users\StarL\Music</c>）
///   → TagReader 读元数据 + 内嵌歌词 + 封面（Covers 内容寻址落盘）
///   → upsert SQLite（mtime+size 未变跳过；全量 = full 忽略增量）
///   → 曲终清理（DB 里存在但磁盘已无 = removed）→ albums 聚合重建。
///
/// 铁律：<b>只读用户文件</b>（§7.2）——异常文件进 quarantine 表，永不写回/删除音频本体；
/// 单文件失败绝不影响整轮（不崩溃纪律与 M2 同源）；失败率 &gt; 0.5% → 停点 P-3 报告
/// （<see cref="ScanResult.FailureRateHigh"/>，由 UI/诊断页提示，不自行换库）。
///
/// 并发：度 4（§7.4-a，BelowNormal 优先级让位播放）；DB 写在收集完成后单线程批处理
/// （Microsoft.Data.Sqlite 连接非线程安全 + 单事务更快）。进度 evt{library} progress ≤1Hz
/// （协议 §6，节流在 <see cref="LibraryApi"/> 侧）。
/// </summary>
public sealed class Scanner
{
    /// <summary>TagLibSharp2 的唯一接触面（R-7.2-a：万一换库只改这个类 + 本文件的取数胶水）。</summary>
    internal sealed class TagReader
    {
        internal sealed record Result(
            string? Title, string? Artist, string? Album, string? AlbumArtist,
            int? Year, string? Genre, int? TrackNo, int? DiscNo,
            long DurationMs, string Codec, int SampleRate, int BitDepth, int Channels, int Bitrate,
            string? Lyrics, byte[]? Cover, string FormatName);

        /// <summary>读取失败返回 (null, 原因)；成功返回 (Result, null)。绝不抛（§7.2 触发面全捕获）。</summary>
        internal static (Result?, string?) Read(string path)
        {
            try
            {
                // 5s 超时红线（§7.2）：MediaFile.Read 是同步 IO——交给带超时的等待包装。
                var task = Task.Run((Func<(Result?, string?)>)(() =>
                {
                    var res = MediaFile.Read(path, DefaultFileSystem.Instance);
                    if (!res.IsSuccess) return (null, res.Error ?? "unreadable");
                    var file = (IMediaFile)res.File!;
                    var tag = file.Tag;
                    var ap = file.AudioProperties;
                    if (tag is null || ap is null || (ap.SampleRate == 0 && ap.Duration <= TimeSpan.Zero))
                        return (null, "no tag/audio properties");

                    // 封面源按容器归一（主进程复跑抓出，M5A-FINDINGS §10）：
                    // FLAC 的 PICTURE 元数据块挂在 FlacFile.Pictures，**不桥接进 Tag.Pictures**
                    // （TagLibSharp2 0.6.0 源码 VorbisComment.Pictures 只对 Ogg 的 base64 字段生效，
                    // 实测本库 964 个 FLAC 全 pictures=0 而 FlacFile.Pictures=1..2）。
                    // MP3/MP4/ASF 走 Tag.Pictures；Ogg 家族两者皆可（base64 字段进 Tag）。
                    IPicture? cover = null;
                    var pictureSources = file is TagLibSharp2.Xiph.FlacFile flacFile
                        ? (IEnumerable<IPicture>)flacFile.Pictures
                        : tag.Pictures;
                    foreach (var pic in pictureSources)
                    {
                        if (pic.PictureType == PictureType.FrontCover) { cover = pic; break; }
                        cover ??= pic; // 无 FrontCover 时用第一张（musicfox 同语义）
                    }

                    byte[]? coverBytes = null;
                    if (cover is not null)
                    {
                        var span = cover.PictureData.ToReadOnlySpan();
                        if (span.Length > 128) coverBytes = span.ToArray();  // <128B 必是坏数据
                    }

                    return (
                        new Result(
                            Nullify(tag.Title), Nullify(tag.Artist), Nullify(tag.Album), Nullify(tag.AlbumArtist),
                            ParseYear(tag.Year), Nullify(tag.Genre),
                            tag.Track is uint tr ? (int)tr : null,
                            tag.DiscNumber is uint dc ? (int)dc : null,
                            // 矛盾检测（§7.2 触发面最后一条）：时长 0 但文件 >1MB → 容器头与体积不符
                            checked((long)ap.Duration.TotalMilliseconds),
                            NormalizeCodec(ap.Codec, res.Format), ap.SampleRate, ap.BitsPerSample, ap.Channels, ap.Bitrate,
                            Nullify(tag.Lyrics), coverBytes, res.Format.ToString()),
                        null);
                }));
                if (!task.Wait(TimeSpan.FromSeconds(5)))
                    return (null, "read timeout (>5s)");
                return task.Result;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException
                or NotSupportedException or ArgumentException
                or InvalidOperationException or OutOfMemoryException or FormatException)
            {
                return (null, $"{ex.GetType().Name}: {ex.Message}");
            }
            catch (Exception ex)
            {
                // 库内未预期异常同样 quarantine（绝不拖垮整轮）；日志留类型与消息。
                Log.Warn($"tagger unexpected: {path} → {ex.GetType().Name}: {ex.Message}");
                return (null, $"unexpected {ex.GetType().Name}");
            }

            static string? Nullify(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
            static int? ParseYear(string? y) =>
                y is { Length: >= 4 } && int.TryParse(y.AsSpan(0, 4), out var v) && v is >= 1000 and <= 2100 ? v : null;
            static string NormalizeCodec(string? codec, MediaFormat fmt)
            {
                if (!string.IsNullOrEmpty(codec)) return codec!.Trim().ToUpperInvariant() switch
                {
                    "MP3" or "MPEG" or "MPEG1" or "MPEG2" or "MPEGLAYER3" => "MP3",
                    _ => codec.Trim().ToUpperInvariant(),
                };
                return fmt switch
                {
                    MediaFormat.Flac => "FLAC",
                    MediaFormat.Mp3 => "MP3",
                    MediaFormat.Wav => "WAV",
                    MediaFormat.OggVorbis or MediaFormat.Opus or MediaFormat.OggFlac => "OGG",
                    MediaFormat.Mp4 => "AAC",
                    MediaFormat.Aiff => "AIFF",
                    MediaFormat.Dsf => "DSD",
                    MediaFormat.Dff => "DSD",
                    MediaFormat.WavPack => "WAVPACK",
                    MediaFormat.MonkeysAudio => "APE",
                    MediaFormat.Musepack => "MUSEPACK",
                    MediaFormat.Asf => "ASF",
                    _ => fmt.ToString().ToUpperInvariant() is { Length: > 0 } x ? x : "UNKNOWN",
                };
            }
        }
    }

    public sealed record ScanOutcome(
        long Scanned, long Added, long Updated, long Removed, long Quarantined,
        long ElapsedMs, long Albums, long Tracks, bool FailureRateHigh, double FailureRate,
        long SkippedUnchanged);

    /// <summary>当前是否处于扫描中（library_busy 判定，协议 §7）。写类命令入口先查此标志。</summary>
    public static bool Busy => Interlocked.CompareExchange(ref _busy, 0, 0) == 1;
    private static int _busy;

    /// <summary>扩展名白名单（v1 解码范围：FLAC/MP3/WAV；其余音频扩展名不入库防误扫）。</summary>
    private static readonly string[] Extensions = [".flac", ".mp3", ".wav"];

    /// <summary>config <c>library.roots</c>（字符串数组）；缺省 = 默认音乐目录。</summary>
    public static string[] Roots()
    {
        var configured = ConfigStore.Get("library.roots") as JsonArray;
        var list = new List<string>();
        if (configured is not null)
        {
            foreach (var item in configured)
            {
                if (item?.GetValueKind() is JsonValueKind.String)
                {
                    var s = item.GetValue<string>();
                    if (!string.IsNullOrWhiteSpace(s)) list.Add(s);
                }
            }
        }
        return list.Count > 0 ? list.ToArray() : [LibraryDb.DefaultRoot];
    }

    /// <summary>
    /// 全库扫描/增量 reconcile（同步执行——调用方放后台线程）。
    /// onProgress(scanned,total,phase) 由 LibraryApi 节流到 ≤1Hz。
    /// </summary>
    public static ScanOutcome Run(bool full, string[] roots, Action<string, long, long>? onProgress = null)
    {
        if (Interlocked.Exchange(ref _busy, 1) == 1)
            throw new LibraryBusyException();

        var startedAt = DateTimeOffset.UtcNow;
        try
        {
            using var db = LibraryDb.Open();

            // 1. 枚举（并行目录遍历；忽略再入错误 = 权限/特殊目录）
            var files = new List<string>();
            var fileGate = new object();
            var options = new ParallelOptions
            {
                MaxDegreeOfParallelism = 4,
                CancellationToken = CancellationToken.None,
            };
            Parallel.ForEach(roots, options, root =>
            {
                if (!Directory.Exists(root)) return;
                var queue = new Stack<string>();
                queue.Push(root);
                while (queue.Count > 0)
                {
                    IEnumerable<string> sub;
                    try
                    {
                        sub = Directory.EnumerateDirectories(queue.Peek());
                    }
                    catch (Exception)
                    {
                        sub = [];
                    }
                    List<string> subDirs = [];
                    foreach (var d in sub) subDirs.Add(d);
                    try
                    {
                        foreach (var f in Directory.EnumerateFiles(queue.Pop()))
                        {
                            if (Array.IndexOf(Extensions, Path.GetExtension(f).ToLowerInvariant()) >= 0)
                            {
                                lock (fileGate) files.Add(f);
                            }
                        }
                    }
                    catch (Exception)
                    {
                        // 目录级权限/瞬态错误：跳过该目录（quarantine 无 path 语义不适用）
                    }
                    foreach (var d in subDirs) queue.Push(d);
                }
            });

            onProgress?.Invoke("start", 0, files.Count);

            // 2. 现存指纹表（mtime+size 增量判定的依据）
            var existing = new Dictionary<string, (long Mtime, long Size, long Id)>(StringComparer.OrdinalIgnoreCase);
            using (var cmd = db.CreateCommand())
            {
                cmd.CommandText = "SELECT id, path, mtime, size FROM tracks;";
                using var r = cmd.ExecuteReader();
                while (r.Read()) existing[r.GetString(1)] = (r.GetInt64(2), r.GetInt64(3), r.GetInt64(0));
            }

            // 3. 并行读标签 + 封面落盘（写库延迟到第 4 步单线程）
            var rows = new List<RowData>(files.Count);
            var quarantines = new List<(string Path, string Reason, long Mtime, long Size)>(16);
            long scanned = 0, skippedUnchanged = 0;
            var rowGate = new object();
            // progress 粗节流（1s 粒度；LibraryApi 侧还有 ≤1Hz 细闸——两层都幂等）。
            long[] lastProgressTick = [Environment.TickCount64];
            Parallel.ForEach(files, options, path =>
            {
                long mtime = 0, size = 0;
                try
                {
                    var info = new FileInfo(path);
                    size = info.Length;
                    mtime = info.LastWriteTimeUtc.Ticks;
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                {
                    lock (rowGate) quarantines.Add((path, $"stat: {ex.GetType().Name}", 0, 0));
                    Interlocked.Increment(ref scanned);
                    MaybeProgress();
                    return;
                }

                if (!full && existing.TryGetValue(path, out var old) && old.Mtime == mtime && old.Size == size)
                {
                    // 增量跳过：行数据原样保留（不重写不重读标签）；
                    // 歌词旁挂路径变化不敏感——M5c watcher 负责重扫该文件。
                    Interlocked.Increment(ref skippedUnchanged);
                    Interlocked.Increment(ref scanned);
                    MaybeProgress();
                    return;
                }

                var (meta, error) = TagReader.Read(path);
                if (meta is null)
                {
                    lock (rowGate) quarantines.Add((path, error ?? "unreadable", mtime, size));
                    Interlocked.Increment(ref scanned);
                    MaybeProgress();
                    return;
                }
                if (meta.DurationMs == 0 && size > 1_048_576)
                {
                    lock (rowGate) quarantines.Add((path, "duration=0 but size>1MB (contradiction)", mtime, size));
                    Interlocked.Increment(ref scanned);
                    MaybeProgress();
                    return;
                }

                string? coverKey = null;
                if (meta.Cover is { Length: > 0 } coverBytes)
                {
                    try
                    {
                        coverKey = Covers.Put(coverBytes);
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
                    {
                        Log.Warn($"cover write failed ({path}): {ex.GetType().Name}");
                    }
                }

                var lyricPath = SidecarLrc(path);
                lock (rowGate) rows.Add(new RowData(path, meta, mtime, size, coverKey, lyricPath));
                Interlocked.Increment(ref scanned);
                MaybeProgress();
            });

            // 文件计数后的统一节流上报（调用方已递增 scanned；本地函数在 Parallel 循环内复用）。
            void MaybeProgress()
            {
                var now = Environment.TickCount64;
                if (now - Interlocked.Read(ref lastProgressTick[0]) >= 1000)
                {
                    Interlocked.Exchange(ref lastProgressTick[0], now);
                    onProgress?.Invoke("progress", Interlocked.Read(ref scanned), files.Count);
                }
            }

            // 4. 单事务 upsert（added/updated 计数 = 与 existing 对比）
            long added = 0, updated = 0;
            var nowUnix = startedAt.ToUnixTimeSeconds();
            using (var tx = db.BeginTransaction())
            {
                foreach (var row in rows)
                {
                    var isUpdate = existing.ContainsKey(row.Path);
                    Upsert(db, tx, row, nowUnix);
                    if (isUpdate) updated++; else added++;
                }
                tx.Commit();
            }

            // 5. removed：DB 有、磁盘枚举无。**只在本次扫描覆盖范围内删**——
            // UI/CLI 指定部分 roots 时不得清空其它目录的行（教训：CDP e2e 扫单目录
            // 差点删掉全库；root 前缀匹配不区分大小写，Windows 路径语义）。
            var present = new HashSet<string>(files, StringComparer.OrdinalIgnoreCase);
            bool CoveredByRoots(string path) => roots.Any(root =>
            {
                var norm = root.TrimEnd('\\', '/');
                return path.Equals(norm, StringComparison.OrdinalIgnoreCase)
                    || path.StartsWith(norm + "\\", StringComparison.OrdinalIgnoreCase);
            });
            long removed = 0;
            using (var tx = db.BeginTransaction())
            {
                foreach (var (path, (_, _, id)) in existing)
                {
                    if (present.Contains(path) || !CoveredByRoots(path)) continue;
                    using var del = db.CreateCommand();
                    del.Transaction = tx;
                    del.CommandText = "DELETE FROM tracks WHERE id=$id;";
                    del.Parameters.AddWithValue("$id", id);
                    removed += del.ExecuteNonQuery();
                }
                tx.Commit();
            }

            // 6. quarantine 落表（attempts 累加，§7.2）
            long quarantined = 0;
            using (var tx = db.BeginTransaction())
            {
                foreach (var (path, reason, mtime, size) in quarantines)
                {
                    QuarantineUpsert(db, tx, path, reason, mtime, size);
                    quarantined++;
                }
                // 本轮成功读到的路径 = 从 quarantine 移除（修好了收敛）
                foreach (var row in rows)
                {
                    using var rm = db.CreateCommand();
                    rm.Transaction = tx;
                    rm.CommandText = "DELETE FROM quarantine WHERE path=$path;";
                    rm.Parameters.AddWithValue("$path", row.Path);
                    rm.ExecuteNonQuery();
                }
                // 磁盘枚举已不存在的路径 = 文件被删 → 隔离记录一并清除
                //（教训：只清成功集会让用户删掉坏文件后 quarantine 计数永久残留）。
                using (var purge = db.CreateCommand())
                {
                    purge.Transaction = tx;
                    var failedPaths = new HashSet<string>(quarantines.Select(q => q.Path), StringComparer.OrdinalIgnoreCase);
                    purge.CommandText = "SELECT path FROM quarantine;";
                    var staleQuarantined = new List<string>();
                    using (var qr = purge.ExecuteReader())
                    {
                        while (qr.Read())
                        {
                            var p = qr.GetString(0);
                            // 只清理「本次已重扫且磁盘上确已消失」的记录（部分 roots 扫描不动别人的隔离行）。
                            if (!failedPaths.Contains(p) && CoveredByRoots(p) && !present.Contains(p)) staleQuarantined.Add(p);
                        }
                    }
                    foreach (var dead in staleQuarantined)
                    {
                        using var rm = db.CreateCommand();
                        rm.Transaction = tx;
                        rm.CommandText = "DELETE FROM quarantine WHERE path=$path;";
                        rm.Parameters.AddWithValue("$path", dead);
                        rm.ExecuteNonQuery();
                    }
                }
                tx.Commit();
            }

            // 7. albums 聚合 + meta
            LibraryDb.RebuildAlbums(db);
            var elapsedMs = (long)(DateTimeOffset.UtcNow - startedAt).TotalMilliseconds;
            SetMeta(db, "last_scan_ms", elapsedMs.ToString());
            SetMeta(db, "last_scan_at", nowUnix.ToString());

            long trackCount = Count(db, "tracks");
            long albumCount = Count(db, "albums");
            double failureRate = scanned == 0 ? 0 : (double)quarantined / scanned;
            onProgress?.Invoke("done", scanned, scanned);

            return new ScanOutcome(scanned, added, updated, removed, quarantined, elapsedMs,
                albumCount, trackCount, failureRate > 0.005, failureRate, skippedUnchanged);
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
        }
    }

    /// <summary>协议 §4.3/§7.4-a：扫描进行中收到写类库命令 → library_busy（可重试）。</summary>
    public sealed class LibraryBusyException : Exception
    {
        public LibraryBusyException() : base("library scan in progress") { }
    }

    private sealed record RowData(string Path, TagReader.Result Meta, long Mtime, long Size,
        string? CoverKey, string? LyricPath);

    private static void Upsert(SqliteConnection db, SqliteTransaction tx, RowData row, long addedAt)
    {
        var m = row.Meta;
        using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO tracks(path, title, artist, album, album_artist, year, genre,
              track_no, disc_no, duration_ms, codec, sample_rate, bit_depth, channels, bitrate,
              album_art_key, lyric_embedded, lyric_path, mtime, size, added_at, stale)
            VALUES ($path,$title,$artist,$album,$albumArtist,$year,$genre,
              $trackNo,$discNo,$durationMs,$codec,$sampleRate,$bitDepth,$channels,$bitrate,
              $coverKey,$lyrics,$lyricPath,$mtime,$size,$addedAt,0)
            ON CONFLICT(path) DO UPDATE SET
              title=excluded.title, artist=excluded.artist, album=excluded.album,
              album_artist=excluded.album_artist, year=excluded.year, genre=excluded.genre,
              track_no=excluded.track_no, disc_no=excluded.disc_no, duration_ms=excluded.duration_ms,
              codec=excluded.codec, sample_rate=excluded.sample_rate, bit_depth=excluded.bit_depth,
              channels=excluded.channels, bitrate=excluded.bitrate,
              album_art_key=excluded.album_art_key, lyric_embedded=excluded.lyric_embedded,
              lyric_path=excluded.lyric_path, mtime=excluded.mtime, size=excluded.size, stale=0;
            """;
        cmd.Parameters.AddWithValue("$path", row.Path);
        Add(cmd, "$title", m.Title);
        Add(cmd, "$artist", m.Artist);
        Add(cmd, "$album", m.Album);
        Add(cmd, "$albumArtist", m.AlbumArtist);
        Add(cmd, "$year", m.Year);
        Add(cmd, "$genre", m.Genre);
        Add(cmd, "$trackNo", m.TrackNo);
        Add(cmd, "$discNo", m.DiscNo);
        Add(cmd, "$durationMs", m.DurationMs);
        Add(cmd, "$codec", m.Codec);
        Add(cmd, "$sampleRate", m.SampleRate);
        Add(cmd, "$bitDepth", m.BitDepth <= 0 ? (int?)null : m.BitDepth);
        Add(cmd, "$channels", m.Channels);
        // Bitrate 语义：kbps（TagReader 规整后）；协议示例是 bps（900000）→ 乘 1000 落库。
        Add(cmd, "$bitrate", m.Bitrate <= 0 ? (long?)null : m.Bitrate * 1000L);
        Add(cmd, "$coverKey", row.CoverKey);
        Add(cmd, "$lyrics", m.Lyrics);
        Add(cmd, "$lyricPath", row.LyricPath);
        cmd.Parameters.AddWithValue("$mtime", row.Mtime);
        cmd.Parameters.AddWithValue("$size", row.Size);
        cmd.Parameters.AddWithValue("$addedAt", addedAt);
        cmd.ExecuteNonQuery();
    }

    private static void QuarantineUpsert(SqliteConnection db, SqliteTransaction tx,
        string path, string reason, long mtime, long size)
    {
        using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            INSERT INTO quarantine(path, reason, mtime, size, seen_at, attempts)
            VALUES ($path,$reason,$mtime,$size,$now,1)
            ON CONFLICT(path) DO UPDATE SET
              reason=excluded.reason, mtime=excluded.mtime, size=excluded.size,
              seen_at=excluded.seen_at, attempts=attempts+1;
            """;
        cmd.Parameters.AddWithValue("$path", path);
        cmd.Parameters.AddWithValue("$reason", reason);
        cmd.Parameters.AddWithValue("$mtime", mtime);
        cmd.Parameters.AddWithValue("$size", size);
        cmd.Parameters.AddWithValue("$now", DateTimeOffset.UtcNow.ToUnixTimeSeconds());
        cmd.ExecuteNonQuery();
    }

    /// <summary>旁挂 .lrc 探测（同目录同名优先；同目录其它 .lrc 不猜）。返回绝对路径或 null。</summary>
    internal static string? SidecarLrc(string audioPath)
    {
        var lrc = Path.ChangeExtension(audioPath, ".lrc");
        return File.Exists(lrc) ? lrc : null;
    }

    private static void Add<T>(SqliteCommand cmd, string name, T? value) =>
        cmd.Parameters.AddWithValue(name, value is null ? DBNull.Value : value);

    private static void SetMeta(SqliteConnection db, string key, string value)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            INSERT INTO meta(key, value) VALUES ($k,$v) ON CONFLICT(key) DO UPDATE SET value=excluded.value;
            """;
        cmd.Parameters.AddWithValue("$k", key);
        cmd.Parameters.AddWithValue("$v", value);
        cmd.ExecuteNonQuery();
    }

    public static long Count(SqliteConnection db, string table)
    {
        // 表名白名单（内部调用，无动态注入面）
        if (table is not ("tracks" or "albums" or "quarantine")) throw new ArgumentException(table);
        using var cmd = db.CreateCommand();
        cmd.CommandText = $"SELECT COUNT(*) FROM {table};";
        return Convert.ToInt64(cmd.ExecuteScalar()!);
    }

    public static long MetaInt(SqliteConnection db, string key)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT value FROM meta WHERE key=$k;";
        cmd.Parameters.AddWithValue("$k", key);
        var text = cmd.ExecuteScalar() as string;
        return long.TryParse(text, out var v) ? v : 0;
    }
}
