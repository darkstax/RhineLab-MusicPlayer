using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using RhineShell.Hosting;

namespace RhineShell.Library;

/// <summary>
/// 曲库命令面（协议 v1.4 §5：library.* 全部**壳侧自答**，不经核心管道；与 config.* 同路由位）。
///
/// 职责：
/// <list type="bullet">
/// <item>cmd 分发与错误码映射（§7：library_busy=可重试 / library_unavailable=不可重试 / bad_request）；</item>
/// <item>evt{library}（§6）：phase start/progress/done，progress ≤1Hz（协议节流红线）；</item>
/// <item>engine.play 的 <c>lib:&lt;id&gt;</c> → <c>file:&lt;绝对路径&gt;</c> 解析（§5.1：核心 scheme 面零改动；
/// 解析失败回 bad_request{unknown lib id}，壳侧产生）；</item>
/// <item>caps 的 "library" 声明在 Bridge（hello），这里只提供实现。</item>
/// </list>
///
/// 线程：cmd 来自 Bridge.HandleCommandAsync（线程池）；DB 每操作一连接（WAL 并发读、单写）。
/// 扫描在专用后台线程；同一时刻至多一个扫描（_scanGate），后来者拿 library_busy。
/// </summary>
public sealed class LibraryApi
{
    private readonly Action<JsonObject> _postEvt;
    private long _evtSeq;
    private long _scanRequested;  // 0=空闲；1=有扫描在跑（Interlocked）

    public LibraryApi(Action<JsonObject> postEvt) => _postEvt = postEvt;

    /// <summary>Bridge 的 library.* 分支入口。返回值 = 待 ack/err 帧（调用方 Post）。</summary>
    public JsonObject Handle(string id, string cmd, JsonObject frame)
    {
        try
        {
            var data = frame["data"] as JsonObject ?? new JsonObject();
            return cmd switch
            {
                "library.scan" => Scan(id, data),
                "library.query" => Query(id, data),
                "library.albums" => Albums(id, data),
                "library.get" => Get(id, data),
                "library.stats" => Stats(id),
                "library.quarantine" => Quarantine(id, data),  // v1.5 只读面（M6），顺带 --cli-quarantine
                _ => Error(id, "not_implemented", $"unknown library cmd {cmd}"),
            };
        }
        catch (SqliteException ex)
        {
            Log.Error($"library {cmd} sqlite failed: {ex.Message}");
            return Error(id, "library_unavailable", "database unavailable (reopen/rebuild from settings)", retryable: false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException
            or InvalidOperationException or ArgumentException or NotSupportedException)
        {
            Log.Error($"library {cmd} failed: {ex.GetType().Name}: {ex.Message}");
            return Error(id, "internal", ex.Message);
        }
    }

    /// <summary>engine.play 前置解析（Bridge 转发核心前调用）：lib:&lt;id&gt; → file:&lt;path&gt;。
    /// 返回替换后的帧（新 data.track_id）；非 lib: 前缀原样返回；解析失败返回 err 帧。</summary>
    public JsonObject? ResolvePlayTrack(JsonObject frame, out JsonObject? errorFrame)
    {
        errorFrame = null;
        var data = frame["data"] as JsonObject;
        var trackId = data?["track_id"]?.GetValueKind() == JsonValueKind.String
            ? data["track_id"]!.GetValue<string>() : null;
        if (trackId is null || !trackId.StartsWith("lib:", StringComparison.Ordinal)) return frame;

        var id = frame["id"]?.GetValue<string>();
        var numeric = trackId[4..];
        if (!long.TryParse(numeric, out var trackRowId) || trackRowId <= 0)
        {
            errorFrame = Error(id, "bad_request", $"unknown lib id (not numeric): {trackId}");
            return null;
        }

        try
        {
            using var db = LibraryDb.Open();
            using var cmd = db.CreateCommand();
            cmd.CommandText = "SELECT path FROM tracks WHERE id=$id;";
            cmd.Parameters.AddWithValue("$id", trackRowId);
            if (cmd.ExecuteScalar() is not string path)
            {
                errorFrame = Error(id, "bad_request", $"unknown lib id: {trackId}");
                return null;
            }
            data!["track_id"] = "file:" + path;
            lock (_sessionGate) _libSession = (trackRowId, path);  // 前端回显改写依据（见 RewriteTrackId）
            return frame;
        }
        catch (SqliteException ex)
        {
            Log.Error($"resolve lib: sqlite failed: {ex.Message}");
            errorFrame = Error(id, "library_unavailable", "database unavailable");
            return null;
        }
    }

    // ---------- lib: 会话回显 ----------
    private readonly object _sessionGate = new();
    private (long Id, string Path)? _libSession;

    /// <summary>
    /// 前端出站帧的 track_id 改写（协议 v1.4 §5.1 的完整语义：lib: 解析**与回显**都是壳的职责，
    /// 核心零改动；M5b 歌词链路 / M5d 点行播放断言都以"前端看到 lib:&lt;id&gt;"为前提）：
    ///   · evt{state}/ack(result) 的 track_id == 当前会话 file: → 返回**改写副本**（不动原帧
    ///     ——SMTC 观察者与重放缓存必须继续看到核心原始 file: 形态，占位取文件名逻辑不破）；
    ///   · 出现其它 file:（用户切到非曲库曲目）→ 会话作废。
    /// 在 UI 线程（Post 入口）调用；锁保 Resolve 线程的写入可见性。
    /// </summary>
    public JsonObject RewriteForFrontend(JsonObject frame)
    {
        (long Id, string Path) session;
        lock (_sessionGate)
        {
            if (_libSession is null) return frame;
            session = _libSession.Value;
        }

        var expected = "file:" + session.Path;
        JsonNode? node = frame["t"]?.GetValueKind() == JsonValueKind.String && frame["t"]!.GetValue<string>() == "ack"
            ? frame["result"]
            : frame["t"]?.GetValueKind() == JsonValueKind.String && frame["t"]!.GetValue<string>() == "evt"
                ? frame["data"]
                : null;
        if (node is not JsonObject obj) return frame;
        if (obj["track_id"]?.GetValueKind() != JsonValueKind.String) return frame;
        var value = obj["track_id"]!.GetValue<string>();
        if (value == expected)
        {
            var copy = (JsonObject)frame.DeepClone();
            var copyData = (copy["t"]!.GetValue<string>() == "ack" ? copy["result"] : copy["data"]) as JsonObject;
            copyData!["track_id"] = $"lib:{session.Id}";
            return copy;
        }
        if (value.StartsWith("file:", StringComparison.Ordinal))
        {
            lock (_sessionGate) _libSession = null;
        }
        return frame;
    }

    // ---------- library.scan ----------

    private JsonObject Scan(string id, JsonObject data)
    {
        if (Interlocked.CompareExchange(ref _scanRequested, 1, 0) != 0)
            return Error(id, "library_busy", "scan in progress", retryable: true);

        string[] roots;
        bool full;
        try
        {
            if (data["roots"] is JsonArray arr && arr.Count > 0)
            {
                var list = new List<string>();
                foreach (var item in arr)
                {
                    if (item?.GetValueKind() == JsonValueKind.String) list.Add(item.GetValue<string>());
                }
                roots = list.Count > 0 ? list.ToArray() : Scanner.Roots();
            }
            else
            {
                roots = Scanner.Roots();
            }
            full = data["full"]?.GetValueKind() == JsonValueKind.True;
        }
        catch (InvalidOperationException)
        {
            Interlocked.Exchange(ref _scanRequested, 0);
            return Error(id, "bad_request", "roots must be an array of strings");
        }

        // 异步执行：ack 立即回 {scanned:0,...,elapsed_ms:0,accepted:true}？——不行：协议 §5 的
        // result 形状是**完成态**（scanned/added/…）。M5a 无头验收（--cli-scan）要同步 JSON；
        // UI 触发则要非阻塞 + evt{library} 推进。折中：ack 按协议形状回，但扫描在**本调用内
        // 后台线程**跑完再回（首轮 44GB 会占住一个线程池线程 ~10-30s，与协议表一致）。
        // progress 事件在扫描线程里节流发出（≤1Hz）。
        try
        {
            var lastProgressMs = 0L;
            var result = Scanner.Run(full, roots, (phase, scanned, total) =>
            {
                var now = Environment.TickCount64;
                if (phase != "progress" || now - lastProgressMs >= 1000 || scanned == total)
                {
                    if (phase == "progress" && now - lastProgressMs < 1000 && scanned != total) return;
                    lastProgressMs = now;
                    PostLibraryEvt(phase, scanned, total);
                }
            });
            var payload = new JsonObject
            {
                ["scanned"] = result.Scanned,
                ["added"] = result.Added,
                ["updated"] = result.Updated,
                ["removed"] = result.Removed,
                ["failed"] = result.Quarantined,
                ["elapsed_ms"] = result.ElapsedMs,
                ["albums"] = result.Albums,
                ["tracks"] = result.Tracks,
                ["failure_rate"] = Math.Round(result.FailureRate, 5),
                ["skipped_unchanged"] = result.SkippedUnchanged,
            };
            if (result.FailureRateHigh)
            {
                // P-3 触发式：不停摆（扫描已完成），但把高失败率如实带给 UI/诊断（FINDINGS 记录处置预案）。
                payload["warning"] = "failure_rate_above_0.5pct";
                Log.Warn($"library scan failure rate {result.FailureRate:P3} > 0.5% (P-3)");
            }
            return Ack(id, payload);
        }
        finally
        {
            Interlocked.Exchange(ref _scanRequested, 0);
        }
    }

    private void PostLibraryEvt(string phase, long scanned, long total)
    {
        var frame = new JsonObject
        {
            ["v"] = 1,
            ["t"] = "evt",
            ["evt"] = "library",
            ["seq"] = Interlocked.Increment(ref _evtSeq),
            ["data"] = new JsonObject
            {
                ["phase"] = phase,
                ["scanned"] = scanned,
                ["total"] = total,
                ["quarantine"] = QuarantineCount(),
            },
        };
        try
        {
            _postEvt(frame);
        }
        catch (Exception ex)
        {
            Log.Warn($"evt{{library}} post failed: {ex.GetType().Name}");
        }
    }

    private static long QuarantineCount()
    {
        try
        {
            using var db = LibraryDb.Open();
            return Scanner.Count(db, "quarantine");
        }
        catch (SqliteException)
        {
            return -1;
        }
    }

    // ---------- 只读命令 ----------

    private JsonObject Query(string id, JsonObject data)
    {
        var scope = data["scope"]?.GetValueKind() == JsonValueKind.String
            ? data["scope"]!.GetValue<string>() : "tracks";
        using var db = LibraryDb.Open();
        var result = scope switch
        {
            "albums" => Search.QueryAlbums(db, data),
            _ => Search.QueryTracks(db, data),
        };
        return Ack(id, result);
    }

    private JsonObject Albums(string id, JsonObject data)
    {
        using var db = LibraryDb.Open();
        return Ack(id, Search.QueryAlbums(db, data));
    }

    private JsonObject Get(string id, JsonObject data)
    {
        if (data["id"] is not JsonValue idValue || !idValue.TryGetValue(out long trackId))
        {
            return Error(id, "bad_request", "library.get requires numeric data.id");
        }

        using var db = LibraryDb.Open();
        string? albumArtist, artist, album, embedded, sidecar;
        JsonObject dto;
        using (var cmd = db.CreateCommand())
        {
            cmd.CommandText = """
                SELECT id, title, artist, album, genre, year, track_no, disc_no, duration_ms,
                       codec, sample_rate, bit_depth, channels, bitrate, album_art_key,
                       lyric_embedded, lyric_path, path, album_artist
                FROM tracks WHERE id=$id;
                """;
            cmd.Parameters.AddWithValue("$id", trackId);
            using var r = cmd.ExecuteReader();
            if (!r.Read()) return Error(id, "bad_request", $"unknown lib id: {trackId}");
            dto = LibraryDb.TrackDto(r);
            static string? Str(SqliteDataReader rd, string col) =>
                rd.IsDBNull(rd.GetOrdinal(col)) ? null : rd.GetString(rd.GetOrdinal(col));
            albumArtist = Str(r, "album_artist");
            artist = Str(r, "artist");
            album = Str(r, "album");
            embedded = Str(r, "lyric_embedded");
            sidecar = Str(r, "lyric_path");
        }

        // album 子对象（协议 §5.1：library.get → {TrackDto, album, lyric_text}）；
        // key 派生式与 RebuildAlbums/TrackHitAlbumKeys 同源。
        var key = LibraryDb.AlbumKey(
            albumArtist is { Length: > 0 } a ? a : (artist is { Length: > 0 } t ? t : "Unknown"),
            album is { Length: > 0 } b ? b : "Unknown");
        JsonObject? albumDto = null;
        using (var acmd = db.CreateCommand())
        {
            acmd.CommandText = """
                SELECT key, title, artist, year, genre, disc_count, track_count, duration_ms, cover_key
                FROM albums WHERE key=$key;
                """;
            acmd.Parameters.AddWithValue("$key", key);
            using var ar = acmd.ExecuteReader();
            if (ar.Read())
            {
                albumDto = LibraryDb.AlbumDto(db, ar.GetString(0), ar.GetString(1), ar.GetString(2),
                    ar.IsDBNull(3) ? null : ar.GetInt64(3), ar.IsDBNull(4) ? null : ar.GetString(4),
                    ar.GetInt64(5), ar.GetInt64(6), ar.GetInt64(7), ar.IsDBNull(8) ? null : ar.GetString(8));
            }
        }
        dto["album"] = albumDto;

        // lyric_text：内嵌优先；旁挂 .lrc 现场读（只读——§7.2 铁律）；都没有 = null（协议 §5.1）。
        string? text = string.IsNullOrWhiteSpace(embedded) ? null : embedded;
        if (text is null && !string.IsNullOrEmpty(sidecar))
        {
            try
            {
                if (File.Exists(sidecar)) text = File.ReadAllText(sidecar);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                Log.Warn($"lyric sidecar unreadable: {sidecar} ({ex.GetType().Name})");
            }
        }
        dto["lyric_text"] = text;
        return Ack(id, dto);
    }

    private JsonObject Stats(string id)
    {
        using var db = LibraryDb.Open();
        return Ack(id, Search.Stats(db, Scanner.Roots()));
    }

    private JsonObject Quarantine(string id, JsonObject data)
    {
        var limit = data["limit"] is JsonValue lv && lv.TryGetValue(out int l)
            ? Math.Clamp(l, 1, 1000) : 100;
        using var db = LibraryDb.Open();
        return Ack(id, Search.Quarantine(db, limit));
    }

    // ---------- 帧构造 ----------

    private static JsonObject Ack(string id, JsonObject result) => new()
    {
        ["v"] = 1,
        ["t"] = "ack",
        ["id"] = id,
        ["result"] = result,
    };

    private static JsonObject Error(string? id, string code, string message, bool retryable = false) => new()
    {
        ["v"] = 1,
        ["t"] = "err",
        ["id"] = id ?? "",
        ["error"] = new JsonObject { ["code"] = code, ["message"] = message, ["retryable"] = retryable },
    };
}
