using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using RhineShell.Hosting;

namespace RhineShell.Library;

/// <summary>
/// 三路径检索路由（M5-PLAN-v2 §7.1 实测结论照抄，不自创）：
///   · len(kw) ≥ 3 → tracks_fts（trigram：任意 ≥3 字符子串，CJK/拉丁一视同仁，大小写不敏感）
///   · 拉丁整词/前缀 → tracks_fts_w（unicode61 remove_diacritics 2，kw* 前缀）
///   · len(kw) &lt; 3 且含 CJK → tracks 上 LIKE '%kw%' COLLATE NOCASE（436 行全表扫 &lt;1ms，兜底）
/// 多关键字（空格分词）：每词独立路由，命中集按行 id 求**交集**语义（词间 AND），
/// 排序合并去重后按（标题/艺术家/专辑列优先级 → 专辑 → 曲目号）截断 LIMIT（≤200）。
///
/// 信任边界（协议 §10 / AGENTS.md）：q 来自自家前端，SQL 全参数化仅是正确性要求
/// （引号/通配符转义），不是注入防御面——FTS5 MATCH 语法错误必须兜底（用户输入里
/// 出现 " * ( ) 等 FTS 特殊字符是正常使用路径，真缺陷而非假想攻击面）。
/// </summary>
public static class Search
{
    private const int MaxLimit = 200;
    /// <summary>R9：limit&lt;=0（不限）时的安全上限——防未来超大曲库把管道/内存撑爆。</summary>
    private const int HardLimit = 20000;

    /// <summary>检索曲目。scope=tracks（默认）。返回 {total, items:[TrackDto]}（协议 §5）。</summary>
    public static JsonObject QueryTracks(SqliteConnection db, JsonObject args)
    {
        var q = args["q"]?.GetValueKind() == JsonValueKind.String ? args["q"]!.GetValue<string>() : null;
        var filter = args["filter"] as JsonObject;
        var sort = args["sort"]?.GetValueKind() == JsonValueKind.String ? args["sort"]!.GetValue<string>() : null;
        var offset = ReadInt(args["offset"], 0);
        // R9（启动卡顿）：limit<=0 = **不限**（与 QueryAlbums 同口径）。显式正数仍钳到
        // [1, HardLimit]，防调用方误传超大值撑爆管道/内存。
        var rawLimit = ReadInt(args["limit"], MaxLimit);
        var limit = rawLimit <= 0 ? HardLimit : Math.Clamp(rawLimit, 1, HardLimit);

        var where = new StringBuilder("WHERE 1=1");
        var ps = new List<(string, object)>();
        var matchIds = IntersectMatch(db, q);  // null = 无 FTS/LIKE 约束（全库浏览）
        var routes = new JsonArray([.. SplitWords(q).Select(w => (JsonNode)JsonValue.Create($"{w}:{RouteOf(w)}")!)]);

        if (matchIds is not null)
        {
            where.Append(" AND id IN (").Append(IdList(matchIds)).Append(')');
        }
        ApplyFilter(filter, where, ps);

        var order = sort switch
        {
            "artist" => "COALESCE(artist,''), COALESCE(album,''), COALESCE(track_no,0)",
            "album" => "COALESCE(album,''), COALESCE(disc_no,0), COALESCE(track_no,0)",
            "year" => "COALESCE(year,0) DESC, COALESCE(album,''), COALESCE(track_no,0)",
            "duration" => "COALESCE(duration_ms,0)",
            "added" => "added_at DESC",
            _ => "COALESCE(title,''), COALESCE(album,''), COALESCE(track_no,0)",  // title（默认）
        };

        using (var cnt = db.CreateCommand())
        {
            cnt.CommandText = $"SELECT COUNT(*) FROM tracks {where};";
            foreach (var (n, v) in ps) cnt.Parameters.AddWithValue(n, v);
            var total = Convert.ToInt64(cnt.ExecuteScalar()!);
            var items = new JsonArray();
            using var cmd = db.CreateCommand();
            cmd.CommandText = $"""
                SELECT id, title, artist, album, genre, year, track_no, disc_no, duration_ms,
                       codec, sample_rate, bit_depth, channels, bitrate, album_art_key,
                       lyric_embedded, lyric_path, path
                FROM tracks {where} ORDER BY {order} LIMIT $limit OFFSET $offset;
                """;
            foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
            cmd.Parameters.AddWithValue("$limit", limit);
            cmd.Parameters.AddWithValue("$offset", Math.Max(0, offset));
            using var r = cmd.ExecuteReader();
            while (r.Read()) items.Add(LibraryDb.TrackDto(r));
            var payload = new JsonObject { ["total"] = total, ["items"] = items };
            if (routes.Count > 0) payload["routes"] = routes;  // 诊断面（--cli-query/FINDINGS 取证）；协议 items 形状不变
            return payload;
        }
    }

    /// <summary>query 分词（空格，与 IntersectMatch 同一拆法——路由报告与实际执行一致）。</summary>
    private static string[] SplitWords(string? q) =>
        q is null ? [] : q.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>专辑查询（scope=albums 与 library.albums 共用）。{total, items:[AlbumDto]}。</summary>
    public static JsonObject QueryAlbums(SqliteConnection db, JsonObject args)
    {
        var q = args["q"]?.GetValueKind() == JsonValueKind.String ? args["q"]!.GetValue<string>() : null;
        var genre = args["genre"]?.GetValueKind() == JsonValueKind.String ? args["genre"]!.GetValue<string>() : null;
        var filter = args["filter"] as JsonObject;
        // R9（启动卡顿）：limit<=0 = **不限**（水合一次性拉全量专辑，避免 200 上限引发的
        // 逐年切片 → 60+ 次串行 IPC）。显式正数仍钳到 [1, HardLimit]，防调用方误传超大值。
        var rawLimit = ReadInt(args["limit"], MaxLimit);
        var limit = rawLimit <= 0 ? HardLimit : Math.Clamp(rawLimit, 1, HardLimit);

        var where = new StringBuilder("WHERE 1=1");
        var ps = new List<(string, object)>();
        // 专辑检索：命中曲目的 album_key 集合 ∪ 专辑名直查（title/artist LIKE）
        var trackHitKeys = TrackHitAlbumKeys(db, q);
        if (q is { Length: > 0 } && trackHitKeys is not null)
        {
            // q 存在：albums 需命中（key 在曲目命中集，或 title/artist LIKE 兜底命中）
            var inClause = trackHitKeys.Count == 0 ? "0=1" : "key IN (" + IdList(trackHitKeys) + ")";
            where.Append($" AND ({inClause} OR title LIKE $qq COLLATE NOCASE ESCAPE '/' OR artist LIKE $qq COLLATE NOCASE ESCAPE '/')");
            ps.Add(("$qq", $"%{EscapeLike(q)}%"));
        }
        if (!string.IsNullOrEmpty(genre))
        {
            where.Append(" AND genre = $genre");
            ps.Add(("$genre", genre!));
        }
        if (filter?["year"]?.GetValueKind() == JsonValueKind.Number)
        {
            where.Append(" AND year = $fyear");
            ps.Add(("$fyear", filter["year"]!.GetValue<int>()));
        }
        if (filter?["artist"]?.GetValueKind() == JsonValueKind.String)
        {
            where.Append(" AND artist LIKE $fartist COLLATE NOCASE ESCAPE '/'");
            ps.Add(("$fartist", $"%{EscapeLike(filter["artist"]!.GetValue<string>())}%"));
        }

        var items = new JsonArray();
        long total;
        using (var cnt = db.CreateCommand())
        {
            cnt.CommandText = $"SELECT COUNT(*) FROM albums {where};";
            foreach (var (n, v) in ps) cnt.Parameters.AddWithValue(n, v);
            total = Convert.ToInt64(cnt.ExecuteScalar()!);
        }
        // 先物化外层行再逐个补聚合（Microsoft.Data.Sqlite 默认无 MARS：同一连接不得在
        // reader 未关时另开 reader）。
        var albumRows = new List<(string Key, string? Title, string? Artist, long? Year, string? Genre, long Discs, long Tracks, long Dur, string? Cover)>();
        using (var cmd = db.CreateCommand())
        {
            cmd.CommandText = $"""
                SELECT key, title, artist, year, genre, disc_count, track_count, duration_ms, cover_key
                FROM albums {where} ORDER BY COALESCE(artist,''), COALESCE(year,0) DESC, COALESCE(title,'')
                LIMIT $limit;
                """;
            foreach (var (n, v) in ps) cmd.Parameters.AddWithValue(n, v);
            cmd.Parameters.AddWithValue("$limit", limit);
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                albumRows.Add((r.GetString(0), r.IsDBNull(1) ? null : r.GetString(1), r.IsDBNull(2) ? null : r.GetString(2),
                    r.IsDBNull(3) ? null : r.GetInt64(3), r.IsDBNull(4) ? null : r.GetString(4),
                    r.GetInt64(5), r.GetInt64(6), r.GetInt64(7), r.IsDBNull(8) ? null : r.GetString(8)));
            }
        }
        // R9：一次预聚合替代 N+1（原每张专辑各查一次 tracks）。344 张 → 1 次 GROUP BY。
        var aggregates = LibraryDb.AggregateFormatsByAlbum(db);
        foreach (var (key, aTitle, aArtist, aYear, aGenre, discs, tracks, dur, cover) in albumRows)
        {
            // 聚合键与 AlbumDto 的匹配式同源（COALESCE(NULLIF(album,''),'Unknown') 等）。
            var ab = string.IsNullOrEmpty(aTitle) ? "Unknown" : aTitle;
            var aa = string.IsNullOrEmpty(aArtist) ? "Unknown" : aArtist;
            aggregates.TryGetValue((ab, aa), out var agg);
            items.Add(LibraryDb.AlbumDtoFromAggregate(
                key, aTitle, aArtist, aYear, aGenre, discs, tracks, dur, cover, agg));
        }
        return new JsonObject { ["total"] = total, ["items"] = items };
    }

    /// <summary>library.stats（协议 §5）。roots 用调用方传入（config 读一次）。</summary>
    public static JsonObject Stats(SqliteConnection db, string[] roots) => new JsonObject
    {
        ["albums"] = Scanner.Count(db, "albums"),
        ["tracks"] = Scanner.Count(db, "tracks"),
        ["genres"] = Genres(db),
        ["roots"] = new JsonArray([.. roots.Select(r => (JsonNode)JsonValue.Create(r)!.DeepClone())]),
        ["last_scan_ms"] = Scanner.MetaInt(db, "last_scan_ms"),
        ["quarantine"] = Scanner.Count(db, "quarantine"),
    };

    private static long Genres(SqliteConnection db)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT COUNT(DISTINCT genre) FROM albums WHERE genre IS NOT NULL AND genre != '';";
        return Convert.ToInt64(cmd.ExecuteScalar()!);
    }

    /// <summary>quarantine 列表（M6 诊断页/--cli-quarantine 消费；协议 v1.5 library.quarantine）。</summary>
    public static JsonObject Quarantine(SqliteConnection db, int limit = 100)
    {
        limit = Math.Clamp(limit, 1, 1000);
        var items = new JsonArray();
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            SELECT path, reason, mtime, size, seen_at FROM quarantine ORDER BY seen_at DESC LIMIT $limit;
            """;
        cmd.Parameters.AddWithValue("$limit", limit);
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            items.Add(new JsonObject
            {
                ["path"] = r.GetString(0),
                ["reason"] = r.IsDBNull(1) ? null : r.GetString(1),
                ["mtime"] = r.IsDBNull(2) ? null : r.GetInt64(2),
                ["size"] = r.IsDBNull(3) ? null : r.GetInt64(3),
                ["seen_at"] = r.IsDBNull(4) ? null : r.GetInt64(4),
            });
        }
        return new JsonObject { ["items"] = items };
    }

    // ---------- 路由核心 ----------

    /// <summary>按 §7.1 三路径路由 q（空格分词、词间 AND=交集）；返回命中行 id 集合，
    /// q 为空/全空白 → null（无约束）。单词命中 0 也返回空集（AND 语义下整体 0 是正确结果，
    /// 但 trigram/unicode61/LIKE 三路径**依次回退**：一个路径 0 命中不等于该词 0 命中）。</summary>
    private static HashSet<long>? IntersectMatch(SqliteConnection db, string? q)
    {
        if (q is null || q.Trim().Length == 0) return null;
        HashSet<long>? acc = null;
        foreach (var word in SplitWords(q))
        {
            var hit = MatchWord(db, word);
            acc = acc is null ? hit : Intersect(acc, hit);
        }
        return acc ?? new HashSet<long>();
    }

    private static HashSet<long> Intersect(HashSet<long> a, HashSet<long> b)
    {
        a.IntersectWith(b);
        return a;
    }

    /// <summary>单词路由（§7.1 三路径 + 回退链，回退是必要的：trigram 对 CJK 子串强、
    /// unicode61 对拉丁整词/前缀快、LIKE 兜 &lt;3 字 CJK 与 FTS 语法边角）。
    ///   · 含非 ASCII（CJK/假名/谚文等）≥3 字符 → trigram 优先 → unicode61 → LIKE；
    ///   · 纯拉丁（含数字/变音符）→ unicode61 整词/前缀优先 → trigram（≥3 时）→ LIKE；
    ///   · &lt;3 字符 CJK → LIKE 直达（unicode61 对 CJK 只有前缀语义，LIKE 是其严格超集，§7.1 实测）。</summary>
    private static HashSet<long> MatchWord(SqliteConnection db, string word)
    {
        bool asciiOnly = true;
        foreach (var c in word)
        {
            if (c > 127) { asciiOnly = false; break; }
        }

        if (asciiOnly)
        {
            var w = Fts(db, "tracks_fts_w", $"{EscapePhrase(word)}*");
            if (w.Count > 0) return w;
            if (word.Length >= 3)
            {
                var hit = Fts(db, "tracks_fts", $"\"{EscapePhrase(word)}\"");
                if (hit.Count > 0) return hit;
            }
        }
        else
        {
            if (word.Length >= 3)
            {
                var hit = Fts(db, "tracks_fts", $"\"{EscapePhrase(word)}\"");
                if (hit.Count > 0) return hit;
                var w = Fts(db, "tracks_fts_w", $"{EscapePhrase(word)}*");
                if (w.Count > 0) return w;
            }
        }
        return Like(db, word);
    }

    /// <summary>诊断面（--cli-query 与 FINDINGS 取证）：单词的落点路径名（不改变语义，独立重算）。</summary>
    public static string RouteOf(string word)
    {
        bool asciiOnly = true;
        foreach (var c in word)
        {
            if (c > 127) { asciiOnly = false; break; }
        }
        if (asciiOnly) return "unicode61→trigram→LIKE";
        return word.Length >= 3 ? "trigram→unicode61→LIKE" : "LIKE";
    }

    private static HashSet<long> Fts(SqliteConnection db, string table, string match)
    {
        // 表名白名单（内部件，非用户输入）
        if (table is not ("tracks_fts" or "tracks_fts_w")) throw new ArgumentException(table);
        var set = new HashSet<long>();
        try
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = $"""
                SELECT rowid FROM {table} WHERE {table} MATCH $m LIMIT 2000;
                """;
            cmd.Parameters.AddWithValue("$m", match);
            using var r = cmd.ExecuteReader();
            while (r.Read()) set.Add(r.GetInt64(0));
        }
        catch (SqliteException ex)
        {
            // 语法错误（残缺引号等）：该路径放弃，调用方落到 LIKE——不崩溃、不误报（§10 纪律在壳内的等价物）。
            Log.Info($"fts path gave up on {table} ({ex.SqliteErrorCode}): {ex.Message[..Math.Min(120, ex.Message.Length)]}");
        }
        return set;
    }

    private static HashSet<long> Like(SqliteConnection db, string word)
    {
        var set = new HashSet<long>();
        using var cmd = db.CreateCommand();
        // 主进程复跑抓出（raw string 里 \\ 是两个字符 → SQLite "ESCAPE must be single
        // character"，2 字 CJK 查询必炸；lane 自报的"岁月→LIKE PASS"未覆盖此路径）。
        // 改用正斜杠做转义符（避开反斜杠在 raw string/转义语义的双重坑），EscapeLike 同步换。
        cmd.CommandText = """
            SELECT id FROM tracks
            WHERE COALESCE(title,'') LIKE $p COLLATE NOCASE ESCAPE '/'
               OR COALESCE(artist,'') LIKE $p COLLATE NOCASE ESCAPE '/'
               OR COALESCE(album,'') LIKE $p COLLATE NOCASE ESCAPE '/'
            LIMIT 2000;
            """;
        cmd.Parameters.AddWithValue("$p", $"%{EscapeLike(word)}%");
        using var r = cmd.ExecuteReader();
        while (r.Read()) set.Add(r.GetInt64(0));
        return set;
    }

    /// <summary>专辑检索用：q 命中的曲目 → albums.key 集合（sha1 hex，可直接进 IN）。</summary>
    private static HashSet<string>? TrackHitAlbumKeys(SqliteConnection db, string? q)
    {
        var ids = IntersectMatch(db, q);
        if (ids is null) return null;
        var keys = new HashSet<string>(StringComparer.Ordinal);
        if (ids.Count == 0) return keys;
        using var cmd = db.CreateCommand();
        // key 由 album/album_artist 派生（RebuildAlbums 同式），这里反查：取命中曲目的（album_artist,album）
        cmd.CommandText = $"""
            SELECT COALESCE(NULLIF(album_artist,''), NULLIF(artist,''), 'Unknown') AS aa,
                   COALESCE(NULLIF(album,''), 'Unknown') AS ab
            FROM tracks WHERE id IN ({IdList(ids)});
            """;
        using var r = cmd.ExecuteReader();
        while (r.Read()) keys.Add(LibraryDb.AlbumKey(r.GetString(0), r.GetString(1)));
        return keys;
    }

    private static void ApplyFilter(JsonObject? filter, StringBuilder where, List<(string, object)> ps)
    {
        if (filter is null) return;
        if (filter["genre"]?.GetValueKind() == JsonValueKind.String)
        {
            where.Append(" AND genre = $fg");
            ps.Add(("$fg", filter["genre"]!.GetValue<string>()));
        }
        if (filter["year"]?.GetValueKind() == JsonValueKind.Number)
        {
            where.Append(" AND year = $fy");
            ps.Add(("$fy", filter["year"]!.GetValue<int>()));
        }
        if (filter["artist"]?.GetValueKind() == JsonValueKind.String)
        {
            where.Append(" AND artist LIKE $fa COLLATE NOCASE ESCAPE '/'");
            ps.Add(("$fa", $"%{EscapeLike(filter["artist"]!.GetValue<string>())}%"));
        }
        if (filter["album"]?.GetValueKind() == JsonValueKind.String)
        {
            where.Append(" AND album LIKE $fb COLLATE NOCASE ESCAPE '/'");
            ps.Add(("$fb", $"%{EscapeLike(filter["album"]!.GetValue<string>())}%"));
        }
    }

    /// <summary>id 集合 → SQL 字面量列表（值全是 SQLite 自增 long，非用户输入；上限 2000）。</summary>
    private static string IdList(IEnumerable<long> ids) =>
        string.Join(',', ids.Take(2000).Select(static i => i.ToString(System.Globalization.CultureInfo.InvariantCulture)));

    private static string IdList(HashSet<string> shaKeys)
    {
        var sb = new StringBuilder();
        foreach (var k in shaKeys.Take(2000))
        {
            if (sb.Length > 0) sb.Append(',');
            sb.Append('\'').Append(k.Replace("'", "''")).Append('\'');  // sha1:hex 理论上无引号，转义是正确性兜底
        }
        return sb.ToString();
    }

    /// <summary>FTS 短语内引号翻倍（"岁月"如"歌" 之类用户输入不炸语法）。</summary>
    private static string EscapePhrase(string s) => s.Replace("\"", "\"\"");

    /// <summary>LIKE 通配符转义（配 ESCAPE '/' 消费：/ → //、% → /%、_ → /_）。
    /// 教训一（--cli-fts-verify 抓出）：SQLite LIKE 无 Access 式 `[_]` 方括号转义；
    /// 教训二（主进程复跑抓出）：raw string 里 ESCAPE '\\' 是两个反斜杠字符 → SQLite 报错，
    /// 转义符统一改正斜杠。</summary>
    private static string EscapeLike(string s) => s.Replace("/", "//").Replace("%", "/%").Replace("_", "/_");

    private static int ReadInt(JsonNode? node, int fallback) =>
        node is JsonValue v && v.TryGetValue(out int val) && val >= 0 ? val : fallback;
}
