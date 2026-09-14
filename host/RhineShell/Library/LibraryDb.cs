using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using RhineShell.Hosting;

namespace RhineShell.Library;

/// <summary>
/// 曲库 SQLite 的打开与 schema（docs/M5-PLAN-v2 §4.4；协议 v1.4 §5/§5.1 数据面）。
///
/// 布局：<c>%LOCALAPPDATA%\RhineMusic\library.db</c>（WAL）+ 同级 <c>covers\</c> 目录
/// （<see cref="Covers"/> 内容寻址封面）。环境变量 <c>RHINE_LIBRARY_DB</c> 覆盖整库目录
/// （无人值守验收与单测隔离用，与 RHINE_SHELL_CONFIG_FILE 同族）。
///
/// 双 FTS5 索引（§7.1 实测结论）：
///   · <c>tracks_fts</c>   = trigram（主：任意 ≥3 字符子串，CJK/拉丁一视同仁）；
///   · <c>tracks_fts_w</c> = unicode61 remove_diacritics 2（辅：拉丁整词/前缀、索引更小）。
/// 两者都是 <c>content='tracks'</c> 外部内容表 + 三触发器同步（正文不双份存储）。
///
/// 连接模型：Microsoft.Data.Sqlite 连接非线程安全——每次操作开新连接（WAL 允许读写并发，
/// busy_timeout 5s 兜底单写者冲突）。436 曲量级下连接开销可忽略。
/// </summary>
public static class LibraryDb
{
    /// <summary>默认曲库根（审查 P1-1）：系统"音乐"目录（本机即 C:\Users\StarL\Music，
    /// 但绝不硬编码个人路径——M6 换用户首启不静默扫 0 文件）。</summary>
    public static string DefaultRoot =>
        Environment.GetFolderPath(Environment.SpecialFolder.MyMusic);

    /// <summary>库根目录（DB 与 covers 的父目录）。</summary>
    public static string Directory => Environment.GetEnvironmentVariable("RHINE_LIBRARY_DB") is { Length: > 0 } @override
        ? @override
        : Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "RhineMusic");

    public static string DbPath => System.IO.Path.Combine(Directory, "library.db");

    public static string ConnectionString => $"Data Source={DbPath}";

    /// <summary>打开（必要时创建 schema）。失败抛异常，调用方映射 library_unavailable（协议 §7）。</summary>
    public static SqliteConnection Open()
    {
        System.IO.Directory.CreateDirectory(Directory);
        var db = new SqliteConnection(ConnectionString);
        db.Open();
        Execute(db, "PRAGMA journal_mode=WAL;");
        Execute(db, "PRAGMA busy_timeout=5000;");
        Execute(db, "PRAGMA foreign_keys=ON;");
        EnsureSchema(db);
        return db;
    }

    /// <summary>R-7.1-a 验收探针：sqlite 版本 + FTS5 编译开关 + trigram 实测建表插查。</summary>
    public static JsonObject Probe()
    {
        using var db = Open();
        var version = Scalar(db, "SELECT sqlite_version();");
        var fts = false;
        using (var cmd = db.CreateCommand())
        {
            cmd.CommandText = "SELECT COUNT(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5';";
            fts = Convert.ToInt64(cmd.ExecuteScalar()!) > 0;
        }

        var trigram = false;
        var trigramError = (string?)null;
        try
        {
            using var probe = new SqliteConnection(ConnectionString);
            probe.Open();
            Execute(probe, "CREATE TEMP TABLE probe_trigram(word TEXT)");
            Execute(probe, """
                CREATE VIRTUAL TABLE TEMP.probe_fts USING fts5(word, tokenize='trigram');
                """);
            Execute(probe, "INSERT INTO probe_fts VALUES ('岁月如歌测试');");
            // trigram 只索引**连续**三元子串（"如如歌"非连续 → 假阴性；用真实连续段）。
            trigram = Scalar(probe, "SELECT COUNT(*) FROM probe_fts WHERE probe_fts MATCH '\"岁月如\"';") == "1";
            Execute(probe, "DROP TABLE probe_fts;DROP TABLE probe_trigram;");
        }
        catch (SqliteException ex)
        {
            trigramError = ex.Message;
        }

        return new JsonObject
        {
            ["sqlite_version"] = version,
            ["compile_fts5"] = fts,
            ["trigram_works"] = trigram,
            ["trigram_error"] = trigramError,
            ["ok"] = fts && trigram,
        };
    }

    private static void Execute(SqliteConnection db, string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private static string Scalar(SqliteConnection db, string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        return cmd.ExecuteScalar()?.ToString() ?? string.Empty;
    }

    /// <summary>幂等建表（§4.4 schema 全文 + 双 FTS + 触发器 + quarantine/user_state/meta）。</summary>
    private static void EnsureSchema(SqliteConnection db)
    {
        Execute(db, """
            CREATE TABLE IF NOT EXISTS tracks(
              id INTEGER PRIMARY KEY,
              path TEXT UNIQUE NOT NULL,
              cue_offset INTEGER NOT NULL DEFAULT 0,
              title TEXT, artist TEXT, album TEXT, album_artist TEXT,
              year INTEGER, genre TEXT, track_no INTEGER, disc_no INTEGER,
              duration_ms INTEGER, codec TEXT, sample_rate INTEGER, bit_depth INTEGER,
              channels INTEGER, bitrate INTEGER, container_bitperfect_capable INTEGER,
              gain_track REAL, gain_album REAL,
              album_art_key TEXT, lyric_embedded TEXT, lyric_path TEXT,
              mtime INTEGER, size INTEGER, added_at INTEGER,
              play_count INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER,
              stale INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS albums(
              key TEXT PRIMARY KEY, title TEXT, artist TEXT, year INTEGER, genre TEXT,
              disc_count INTEGER, track_count INTEGER, duration_ms INTEGER,
              cover_key TEXT, scanned_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS quarantine(
              path TEXT PRIMARY KEY, reason TEXT, mtime INTEGER, size INTEGER,
              seen_at INTEGER, attempts INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE IF NOT EXISTS user_state(
              kind TEXT, key TEXT, value TEXT, at INTEGER,
              PRIMARY KEY(kind, key)
            );
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
            """);

        // 双 FTS（外部内容表 + rowid 映射 content_rowid='id'，§4.4/§7.1）
        Execute(db, """
            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts USING fts5(
              title, artist, album,
              content='tracks', content_rowid='id',
              tokenize='trigram'
            );
            """);
        Execute(db, """
            CREATE VIRTUAL TABLE IF NOT EXISTS tracks_fts_w USING fts5(
              title, artist, album,
              content='tracks', content_rowid='id',
              tokenize='unicode61 remove_diacritics 2'
            );
            """);

        // 三触发器（insert/delete/update 同步两张 FTS；update 用 delete+insert 标准形）。
        foreach (var fts in new[] { "tracks_fts", "tracks_fts_w" })
        {
            Execute(db, $"""
                CREATE TRIGGER IF NOT EXISTS {fts}_ai AFTER INSERT ON tracks BEGIN
                  INSERT INTO {fts}(rowid, title, artist, album)
                  VALUES (new.id, coalesce(new.title,''), coalesce(new.artist,''), coalesce(new.album,''));
                END;
                """);
            Execute(db, $"""
                CREATE TRIGGER IF NOT EXISTS {fts}_ad AFTER DELETE ON tracks BEGIN
                  INSERT INTO {fts}({fts}, rowid, title, artist, album)
                  VALUES ('delete', old.id, coalesce(old.title,''), coalesce(old.artist,''), coalesce(old.album,''));
                END;
                """);
            Execute(db, $"""
                CREATE TRIGGER IF NOT EXISTS {fts}_au AFTER UPDATE ON tracks BEGIN
                  INSERT INTO {fts}({fts}, rowid, title, artist, album)
                  VALUES ('delete', old.id, coalesce(old.title,''), coalesce(old.artist,''), coalesce(old.album,''));
                  INSERT INTO {fts}(rowid, title, artist, album)
                  VALUES (new.id, coalesce(new.title,''), coalesce(new.artist,''), coalesce(new.album,''));
                END;
                """);
        }
    }

    /// <summary>专辑聚合键：sha1(album_artist \0 album)，与封面 key 同一"sha1:&lt;hex&gt;"文法（协议 §5.1）。</summary>
    public static string AlbumKey(string albumArtist, string album)
    {
        var bytes = Encoding.UTF8.GetBytes($"{albumArtist}\0{album}");
        return "sha1:" + Convert.ToHexStringLower(SHA1.HashData(bytes));
    }

    /// <summary>tracks 行 → TrackDto（协议 §5.1 字段不多不少；lyric_state 在此派生）。</summary>
    public static JsonObject TrackDto(SqliteDataReader r)
    {
        var lyricEmbedded = Text(r, "lyric_embedded");
        var lyricPath = Text(r, "lyric_path");
        var lyricState = !string.IsNullOrEmpty(lyricEmbedded) ? "embedded"
            : !string.IsNullOrEmpty(lyricPath) && File.Exists(lyricPath) ? "sidecar"
            : "none";
        return new JsonObject
        {
            ["id"] = r.GetInt64(r.GetOrdinal("id")),
            ["title"] = Text(r, "title"),
            ["artist"] = Text(r, "artist"),
            ["album"] = Text(r, "album"),
            ["genre"] = Text(r, "genre"),
            ["year"] = NullInt(r, "year"),
            ["track_no"] = NullInt(r, "track_no"),
            ["disc_no"] = NullInt(r, "disc_no"),
            ["duration_ms"] = NullInt(r, "duration_ms"),
            ["codec"] = Text(r, "codec"),
            ["sample_rate"] = NullInt(r, "sample_rate"),
            ["bit_depth"] = NullInt(r, "bit_depth"),
            ["channels"] = NullInt(r, "channels"),
            ["bitrate"] = NullInt(r, "bitrate"),
            ["cover_key"] = Text(r, "album_art_key"),
            ["lyric_state"] = lyricState,
            ["path"] = Text(r, "path"),
        };
    }

    /// <summary>AlbumDto 的 formats/bitrate_range/resolution 需要 tracks 聚合——统一在此补齐。
    /// 关联方式与 RebuildAlbums 同源（title/artist 即分组时的 album/album_artist 派生值；
    /// §4.4 schema 不在 tracks 存 album_key，故用同一派生表达式 JOIN，436 行量级零压力）。</summary>
    public static JsonObject AlbumDto(SqliteConnection db, string key, string? title, string? artist,
        long? year, string? genre, long discCount, long trackCount, long durationMs, string? coverKey)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT codec, bitrate, sample_rate, bit_depth FROM tracks
            WHERE COALESCE(NULLIF(album,''), 'Unknown') = $ab
              AND COALESCE(NULLIF(album_artist,''), NULLIF(artist,''), 'Unknown') = $aa;
            """;
        cmd.Parameters.AddWithValue("$ab", title ?? "Unknown");
        cmd.Parameters.AddWithValue("$aa", artist ?? "Unknown");
        var codecs = new SortedSet<string>(StringComparer.Ordinal);
        long minBitrate = long.MaxValue, maxBitrate = long.MinValue;
        long maxRate = 0, maxDepth = 0;
        var lossy = false;
        using (var r = cmd.ExecuteReader())
        {
            while (r.Read())
            {
                var codec = r.IsDBNull(0) ? null : r.GetString(0);
                if (!string.IsNullOrEmpty(codec)) codecs.Add(codec!);
                if (codec is "MP3" or "AAC" or "OGG" or "OPUS") lossy = true;
                if (!r.IsDBNull(1))
                {
                    minBitrate = Math.Min(minBitrate, r.GetInt64(1));
                    maxBitrate = Math.Max(maxBitrate, r.GetInt64(1));
                }
                if (!r.IsDBNull(2)) maxRate = Math.Max(maxRate, r.GetInt64(2));
                if (!r.IsDBNull(3)) maxDepth = Math.Max(maxDepth, r.GetInt64(3));
            }
        }

        return new JsonObject
        {
            ["album_key"] = key,
            ["title"] = title,
            ["artist"] = artist,
            ["year"] = year,
            ["genre"] = genre,
            ["disc_count"] = discCount,
            ["track_count"] = trackCount,
            ["duration_ms"] = durationMs,
            ["cover_key"] = coverKey,
            ["formats"] = new JsonArray([.. codecs.Select(c => (JsonNode)JsonValue.Create(c)!)]),
            ["bitrate_range"] = minBitrate <= maxBitrate
                ? new JsonArray(minBitrate, maxBitrate)
                : null,
            ["resolution"] = new JsonObject
            {
                ["lossy"] = lossy,
                ["sample_rate"] = maxRate != 0 ? maxRate : null,
                ["bit_depth"] = maxDepth != 0 ? maxDepth : null,
            },
        };
    }

    private static string? Text(SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : r.GetString(i);
    }

    private static JsonNode? NullInt(SqliteDataReader r, string column)
    {
        var i = r.GetOrdinal(column);
        return r.IsDBNull(i) ? null : JsonValue.Create(r.GetInt64(i));
    }

    /// <summary>albums 全量重建（436 曲量级：C# 内存聚合 &lt;10ms；album_key 是 sha1，
    /// SQL 端算不了，故分组在托管侧做）。保持 albums 与 tracks 严格一致（扫描尾/全量尾各一次）。</summary>
    public static void RebuildAlbums(SqliteConnection db)
    {
        var groups = new Dictionary<string, AlbumAgg>(StringComparer.Ordinal);
        using (var cmd = db.CreateCommand())
        {
            cmd.CommandText = """
                SELECT album, album_artist, artist, year, genre, disc_no, duration_ms, album_art_key
                FROM tracks;
                """;
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var album = r.IsDBNull(0) ? null : r.GetString(0);
                var albumArtist = r.IsDBNull(1) ? null : r.GetString(1);
                var artist = r.IsDBNull(2) ? null : r.GetString(2);
                var aa = string.IsNullOrEmpty(albumArtist) ? (string.IsNullOrEmpty(artist) ? "Unknown" : artist!) : albumArtist!;
                var ab = string.IsNullOrEmpty(album) ? "Unknown" : album!;
                var key = $"{aa}\0{ab}";  // 分组键；写库时再 sha1 成协议 §5.1 的 "sha1:<hex>"
                if (!groups.TryGetValue(key, out var agg))
                {
                    agg = new AlbumAgg();
                    groups[key] = agg;
                }
                if (!r.IsDBNull(3)) agg.Year = Math.Max(agg.Year ?? 0, r.GetInt64(3));
                if (agg.Genre is null or "" && !r.IsDBNull(4)) agg.Genre = r.IsDBNull(4) ? agg.Genre : r.GetString(4);
                if (!r.IsDBNull(5)) agg.MaxDisc = Math.Max(agg.MaxDisc, r.GetInt64(5));
                agg.Tracks++;
                if (!r.IsDBNull(6)) agg.DurationMs += r.GetInt64(6);
                if (agg.Cover is null && !r.IsDBNull(7)) agg.Cover = r.GetString(7);
            }
        }

        using var tx = db.BeginTransaction();
        using (var del = db.CreateCommand())
        {
            del.Transaction = tx;
            del.CommandText = "DELETE FROM albums;";
            del.ExecuteNonQuery();
        }
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        foreach (var (groupKey, agg) in groups)
        {
            var sep = groupKey.IndexOf('\0');
            var albumArtist = groupKey[..sep];
            var album = groupKey[(sep + 1)..];
            using var ins = db.CreateCommand();
            ins.Transaction = tx;
            ins.CommandText = """
                INSERT INTO albums(key, title, artist, year, genre, disc_count, track_count, duration_ms, cover_key, scanned_at)
                VALUES ($key, $title, $artist, $year, $genre, $disc, $tracks, $dur, $cover, $now)
                ON CONFLICT(key) DO UPDATE SET title=excluded.title, artist=excluded.artist, year=excluded.year,
                  genre=excluded.genre, disc_count=excluded.disc_count, track_count=excluded.track_count,
                  duration_ms=excluded.duration_ms, cover_key=excluded.cover_key, scanned_at=excluded.scanned_at;
                """;
            ins.Parameters.AddWithValue("$key", AlbumKey(albumArtist, album));
            ins.Parameters.AddWithValue("$title", album);
            ins.Parameters.AddWithValue("$artist", albumArtist);
            ins.Parameters.AddWithValue("$year", agg.Year.HasValue ? agg.Year.Value : DBNull.Value);
            ins.Parameters.AddWithValue("$genre", string.IsNullOrEmpty(agg.Genre) ? DBNull.Value : agg.Genre!);
            ins.Parameters.AddWithValue("$disc", agg.MaxDisc);
            ins.Parameters.AddWithValue("$tracks", agg.Tracks);
            ins.Parameters.AddWithValue("$dur", agg.DurationMs);
            ins.Parameters.AddWithValue("$cover", agg.Cover ?? (object)DBNull.Value);
            ins.Parameters.AddWithValue("$now", now);
            ins.ExecuteNonQuery();
        }
        tx.Commit();
    }

    private sealed class AlbumAgg
    {
        public long? Year;
        public string? Genre;
        public long MaxDisc = 1;
        public long Tracks;
        public long DurationMs;
        public string? Cover;
    }
}
