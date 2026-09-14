using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;
using RhineShared;
using RhineShell.Hosting;

namespace RhineShell.Library;

/// <summary>
/// 壳的无头自检开关（M5-PLAN-v2 §4.6，专为验收 8-12；与 --core-exe/--no-smtc 同族）。
/// 不开窗、不抢单实例锁；stdout 末行 JSON（其余行走 stderr/日志），退出码 0=成 1=败。
///
/// 所有权说明（FINDINGS 备案）：任务书文件清单未列 App.xaml.cs，但 §4.6 的 --cli-* 必须
/// 有启动入口——App.OnStartup 只加了 6 行分发钩子（CLI 模式跳过窗口/互斥体/SMTC），
/// 全部逻辑集中在本文件（Library/** 所有权内）。
/// </summary>
public static class Cli
{
    public static int Run(ShellOptions options)
    {
        try
        {
            if (options.CliScan) return Scan(options);
            return options.CliMode switch
            {
                "sqlite-probe" => SqliteProbe(),
                "query" => Query(options.CliArg ?? ""),
                "fts-verify" => FtsVerify(),
                "quarantine" => QuarantineList(),
                "stats" => Stats(),
                _ => Fail("unknown cli mode"),
            };
        }
        catch (Exception ex)
        {
            return Fail($"{ex.GetType().Name}: {ex.Message}");
        }
    }

    private static void Out(JsonNode payload)
    {
        // 无头模式的证据消费方是脚本（node/python）：直接写 UTF-8 字节，
        // 绕开 Win 控制台代码页对中文的破坏（输出乱码会让验收误判 0 命中）。
        var bytes = System.Text.Encoding.UTF8.GetBytes(payload.ToJsonString(IpcFrame.Json) + "\n");
        Console.OpenStandardOutput().Write(bytes, 0, bytes.Length);
        Console.Out.Flush();
    }

    private static int Fail(string message)
    {
        Out(new JsonObject { ["ok"] = false, ["error"] = message });
        return 1;
    }

    // ---------- --cli-scan [root...] ----------

    private static int Scan(ShellOptions options)
    {
        var roots = options.CliRoots.Length > 0 ? options.CliRoots : Scanner.Roots();
        // 探针先行（R-7.1-a：trigram 不可用即停手上报，不许静默退化 LIKE-only）
        var probe = LibraryDb.Probe();
        if (probe["ok"]?.GetValue<bool>() != true)
        {
            Out(new JsonObject { ["ok"] = false, ["error"] = "sqlite-probe failed", ["probe"] = probe });
            return 1;
        }

        // full=false：首轮（空 DB）自然全量，同命令重跑 = 增量 reconcile
        // （§4.6 验收 9：elapsed <2s 且 added=0 updated=0）；强制全量走 library.scan {full:true}。
        var result = Scanner.Run(full: options.CliFull, roots);
        Out(new JsonObject
        {
            ["ok"] = true,
            ["roots_received"] = new JsonArray([.. roots.Select(r => (JsonNode)JsonValue.Create(r)!)]),
            ["scanned"] = result.Scanned,
            ["albums"] = result.Albums,
            ["tracks"] = result.Tracks,
            ["added"] = result.Added,
            ["updated"] = result.Updated,
            ["removed"] = result.Removed,
            ["failed"] = result.Quarantined,
            ["failure_rate"] = Math.Round(result.FailureRate, 5),
            ["failure_rate_high"] = result.FailureRateHigh,  // P-3 触发标志
            ["roots_missing"] = result.RootsMissing,          // 审查 P1-1：roots 全不存在=配置错误非空库
            ["elapsed_ms"] = result.ElapsedMs,
            ["skipped_unchanged"] = result.SkippedUnchanged,
        });
        return result.FailureRateHigh ? 3 : 0;  // 3 = 完成但 P-3（验收脚本区分）
    }

    // ---------- --cli-sqlite-probe ----------

    private static int SqliteProbe()
    {
        var probe = LibraryDb.Probe();
        Out(new JsonObject { ["ok"] = probe["ok"]?.GetValue<bool>() == true, ["probe"] = probe });
        return probe["ok"]?.GetValue<bool>() == true ? 0 : 1;
    }

    // ---------- --cli-query <q> ----------

    private static int Query(string q)
    {
        // "N:" 前缀 = 按 id 取全字段（library.get 等价，验收 10 的补充面）；否则走 query。
        using var db = LibraryDb.Open();
        var args = new JsonObject { ["q"] = q, ["scope"] = "tracks", ["limit"] = 200 };
        var result = Search.QueryTracks(db, args);
        var albums = Search.QueryAlbums(db, new JsonObject { ["q"] = q, ["limit"] = 50 });
        Out(new JsonObject
        {
            ["ok"] = true,
            ["q"] = q,
            ["tracks_total"] = result["total"]?.DeepClone(),
            ["albums_total"] = albums["total"]?.DeepClone(),
            ["items"] = result["items"]?.DeepClone(),
            ["album_items"] = albums["items"]?.DeepClone(),
            ["routes"] = result["routes"]?.DeepClone(),
        });
        return 0;
    }

    // ---------- --cli-fts-verify（R-7.1-b：trigram 索引命中集 == LIKE 全扫命中集） ----------

    private static int FtsVerify()
    {
        using var db = LibraryDb.Open();
        // 随机抽 30 曲（库小，ORDER BY RANDOM 可接受），每曲取标题里所有 ≥3 字滑窗词做比对。
        var words = new List<string>();
        using (var cmd = db.CreateCommand())
        {
            cmd.CommandText = "SELECT title FROM tracks WHERE title IS NOT NULL AND length(title) >= 3 ORDER BY RANDOM() LIMIT 30;";
            using var r = cmd.ExecuteReader();
            while (r.Read())
            {
                var title = r.GetString(0);
                // 取整标题 + 3/4 字子窗（滑窗上限防词量爆炸：每曲 ≤6 词）
                words.Add(title);
                for (var i = 0; i + 3 <= title.Length && words.Count % 6 < 6; i++)
                    words.Add(title[i..(i + 3)]);
            }
        }

        int mismatches = 0, checkedWords = 0;
        var firstDiff = (string?)null;
        foreach (var word in words.Distinct().Take(240))
        {
            checkedWords++;
            // trigram 命中集
            var trigram = new HashSet<long>();
            using (var cmd = db.CreateCommand())
            {
                cmd.CommandText = """SELECT rowid FROM tracks_fts WHERE tracks_fts MATCH $m;""";
                cmd.Parameters.AddWithValue("$m", "\"" + word.Replace("\"", "\"\"") + "\"");
                using var r = cmd.ExecuteReader();
                while (r.Read()) trigram.Add(r.GetInt64(0));
            }
            // LIKE 全扫命中集（同列集：title/artist/album）
            var like = new HashSet<long>();
            using (var cmd = db.CreateCommand())
            {
                cmd.CommandText = """
                    SELECT id FROM tracks
                    WHERE COALESCE(title,'') LIKE $p COLLATE NOCASE ESCAPE '\'
                       OR COALESCE(artist,'') LIKE $p COLLATE NOCASE ESCAPE '\'
                       OR COALESCE(album,'') LIKE $p COLLATE NOCASE ESCAPE '\';
                    """;
                cmd.Parameters.AddWithValue("$p", "%" + word.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%");
                using var r = cmd.ExecuteReader();
                while (r.Read()) like.Add(r.GetInt64(0));
            }
            if (!trigram.SetEquals(like))
            {
                mismatches++;
                firstDiff ??= $"word={word}: trigram={trigram.Count} like={like.Count}";
            }
        }

        Out(new JsonObject
        {
            ["ok"] = mismatches == 0,
            ["checked_words"] = checkedWords,
            ["mismatches"] = mismatches,
            ["first_diff"] = firstDiff,
        });
        return mismatches == 0 ? 0 : 1;
    }

    // ---------- --cli-quarantine ----------

    private static int QuarantineList()
    {
        using var db = LibraryDb.Open();
        var result = Search.Quarantine(db, 20);
        Out(new JsonObject { ["ok"] = true, ["quarantine"] = (JsonNode?)result["items"]?.DeepClone() });
        return 0;
    }

    // ---------- --cli-stats ----------

    private static int Stats()
    {
        using var db = LibraryDb.Open();
        Out(new JsonObject { ["ok"] = true, ["stats"] = Search.Stats(db, Scanner.Roots()) });
        return 0;
    }
}
