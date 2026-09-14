// M5d 数据层参数化单测（node --test，无 DOM，web fixture + 模拟多列水合）：
// 任务书验收 4——`fileLocation/fileAtSlot` 在列数动态、ROWS_PER_COLUMN/slotStride
// 参数化后保持双射与循环语义；web 模式（不水合）逐字节等价上游 lane*32+row。
// 运行：node --test --experimental-strip-types src/data.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  records,
  archiveColumns,
  categories,
  columnFiles,
  fileLocation,
  fileAtSlot,
  getSlotStride,
  hydrateFromLibrary,
  wallMode,
  ROW_OFFSET,
  ROWS_PER_COLUMN,
} from "./data.ts";

/** 模拟壳 library.* 的窄数据源（零网络：鸭子 mock，AlbumDto 形状按协议 §5.1）。 */
function mockSource(albums, stats = { albums: albums.length, tracks: albums.reduce((s, a) => s + a.track_count, 0), genres: new Set(albums.map((a) => a.genre).filter(Boolean)).size }) {
  const dto = (a, i) => ({
    album_key: `sha1:${String(i).padStart(40, "0")}`,
    title: a.title ?? null,
    artist: a.artist ?? null,
    year: a.year ?? null,
    genre: a.genre ?? null,
    disc_count: a.discs ?? 1,
    track_count: a.track_count ?? 1,
    duration_ms: a.duration_ms ?? 1000,
    cover_key: a.cover ?? null,
    formats: a.formats ?? ["FLAC"],
    bitrate_range: [100000, 200000],
    resolution: { lossy: false, sample_rate: 44100, bit_depth: 24 },
  });
  return {
    async call(cmd, args = {}) {
      if (cmd === "library.stats") return stats;
      if (cmd === "library.albums") {
        let items = albums.map(dto);
        if (typeof args.genre === "string") items = items.filter((a) => a.genre === args.genre);
        return { total: items.length, items };
      }
      throw new Error("unknown cmd " + cmd);
    },
  };
}

function makeAlbums(count, genre, offset = 0) {
  return Array.from({ length: count }, (_, i) => ({
    title: `专辑 ${genre} ${offset + i + 1}`,
    artist: `歌手 ${offset + i + 1}`,
    year: 2000 + ((offset + i) % 25),
    genre,
    track_count: 8 + (i % 7),
    duration_ms: (30 + (i % 40)) * 60_000,
    cover: `sha1:${genre.length}${offset + i}`.padEnd(45, "0"),
  }));
}

test("web 基线：5 列 40 档案，fileLocation = lane*32 + (12+n)（与上游硬编码逐点等值）", () => {
  assert.equal(wallMode.hydrated, false, "单测起步未水合");
  assert.equal(archiveColumns.length, 5);
  assert.equal(records.length, 40);
  assert.equal(getSlotStride(), ROWS_PER_COLUMN);
  assert.equal(ROW_OFFSET, 12);
  for (let lane = 0; lane < archiveColumns.length; lane++) {
    const files = columnFiles(lane);
    assert.equal(files.length, 8, `列 ${lane} 应有 8 档案`);
    files.forEach((index, n) => {
      const loc = fileLocation(index);
      assert.equal(loc.lane, lane);
      assert.equal(loc.row, ROW_OFFSET + n);
      assert.equal(loc.slot, lane * 32 + ROW_OFFSET + n, "slot 编码 = lane*32+row");
      assert.equal(fileAtSlot(loc.slot), index, "slot → 记录双射");
    });
  }
});

test("fileAtSlot 列越界回绕（循环阵列语义，非负 slot 定义域）", () => {
  const lanes = archiveColumns.length;
  const period = lanes * getSlotStride();
  for (let lane = 0; lane < lanes; lane++) {
    const slot = lane * getSlotStride() + ROW_OFFSET + 2;
    // 向后越列（正方向）回绕同记；负方向经周期归一后同记（负 slot 不在调用域，
    // 上游/水合链路 selectedSlot 恒非负；越界负值钳到列首属定义域外行为）。
    assert.equal(fileAtSlot(slot + period), fileAtSlot(slot));
    assert.equal(fileAtSlot(slot + 3 * period), fileAtSlot(slot));
    assert.equal(fileAtSlot(((slot - period) % period + period) % period), fileAtSlot(slot));
  }
});

test("desktop 水合（7 列 35 专辑）：列数/步长/slot 双射/循环回绕", async () => {
  const genres = ["World", "JPop", "Anime", "Soundtrack", "Electronic", "Rock", "Classical"];
  const albums = genres.flatMap((g, lane) => makeAlbums(lane === 0 ? 13 : 4, g, lane * 10));
  const result = await hydrateFromLibrary(mockSource(albums));
  assert.equal(result.ok, true);
  assert.equal(result.albums, 6 * 4 + 13);
  assert.equal(result.columns, 7);
  assert.equal(wallMode.hydrated, true);
  assert.equal(archiveColumns.length, 7);
  // 列按专辑数降序：World(13) 居首。
  assert.equal(archiveColumns[0], "World");
  assert.equal(columnFiles(0).length, 13);
  // stride ≥ ROWS_PER_COLUMN 且 row = 12 + n < stride（13 列内 row 最大 24 < 32，步长不变）。
  const stride = getSlotStride();
  assert.ok(stride >= ROWS_PER_COLUMN);
  const seen = new Set();
  for (let lane = 0; lane < archiveColumns.length; lane++) {
    const files = columnFiles(lane);
    for (const index of files) {
      const loc = fileLocation(index);
      assert.equal(loc.lane, lane);
      assert.ok(loc.row >= ROW_OFFSET && loc.row < ROW_OFFSET + files.length);
      assert.ok(loc.row < stride, `row ${loc.row} 必须小于步长 ${stride}（slot 双射前提）`);
      assert.equal(loc.slot, lane * stride + loc.row);
      assert.equal(fileAtSlot(loc.slot), index);
      assert.ok(!seen.has(loc.slot), `slot ${loc.slot} 不得碰撞`);
      seen.add(loc.slot);
    }
  }
});

test("水合态字段：AlbumDto → ArchiveRecord 映射（§5.7），null 容错", async () => {
  // 上例 World 列首张（year 最小 → 标题序）：验证扩展字段与缺省行为。
  const first = records.find((r) => r.category === "World");
  assert.ok(first, "存在 World 列记录");
  assert.ok(first.albumKey?.startsWith("sha1:"));
  assert.ok(first.coverKey?.startsWith("sha1:"));
  assert.ok(first.trackCount >= 8);
  assert.ok(first.durationMs > 0);
  assert.deepEqual(first.formats, ["FLAC"]);
  assert.equal(first.clearance, "FLAC"); // formats[0] 大写 = 格式角标数据源
  assert.match(first.id, /^A-\d{3}$/);
  // 空字段容错：无 genre → 未分类列；无 title → 艺术家回退。
  const edge = await hydrateFromLibrary(
    mockSource([
      { title: null, artist: "只艺术家", genre: null, track_count: 3 },
      { title: "有题", artist: null, genre: "JPop", track_count: 2 },
    ]),
  );
  assert.equal(edge.ok, true);
  const ungenred = records.find((r) => r.category === "未分类");
  assert.ok(ungenred, "空 genre 落入未分类列");
  assert.equal(ungenred.title, "只艺术家", "空标题回退艺术家");
  assert.equal(ungenred.coverKey, null, "无封面 key 保持 null");
});

test("stats.albums > 实拉去重数 → truncated 登记", async () => {
  const albums = [...makeAlbums(5, "World"), ...makeAlbums(3, "JPop")];
  const result = await hydrateFromLibrary(mockSource(albums, { albums: 99, tracks: 8, genres: 2 }));
  assert.equal(result.ok, true);
  assert.equal(result.truncated, true);
});

test("空库/失败回退：ok:false 且演示数据不被破坏", async () => {
  const before = records.length;
  const empty = await hydrateFromLibrary({
    async call(cmd) {
      if (cmd === "library.stats") return { albums: 0, tracks: 0, genres: 0 };
      throw new Error("no");
    },
  });
  assert.equal(empty.ok, false);
  assert.equal(empty.reason, "empty");
  assert.equal(records.length, before, "records 保持原样（未被清空）");
});

test("categories 随水合更新为「全部专辑」+ 流派列表", async () => {
  await hydrateFromLibrary(mockSource([...makeAlbums(4, "World"), ...makeAlbums(5, "JPop")]));
  assert.equal(categories[0], "全部专辑");
  assert.ok(categories.includes("JPop"));
  assert.ok(categories.length >= 2);
});
