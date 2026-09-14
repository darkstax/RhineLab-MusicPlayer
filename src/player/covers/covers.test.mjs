// M5d 封面管线纯逻辑单测（node --test，无 DOM/无 GPU）：
// texture-cache 预算/阶梯/超级性能减半 + degrade 五条件与滞回（M5-PLAN-v2 §5.4 写死项）。
// 运行：node --test --experimental-strip-types src/player/covers/covers.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  CoverTextureCache,
  STANDARD_BUDGET,
  PERFORMANCE_BUDGET,
  EDGE_LADDER,
  pickLadderEdge,
} from "./texture-cache.ts";
import {
  CoverDegrader,
  DEGRADE_REASONS,
  normalizeUserMode,
  USER_MODES,
} from "./degrade.ts";

const fakeRenderer = { capabilities: { maxTextureSize: 4096 } };

test("预算常量与阶梯（标准 24/96MiB/512²，超级 12/32MiB/256²）", () => {
  assert.deepEqual(STANDARD_BUDGET, { maxTextures: 24, maxBytes: 96 * 1024 * 1024, maxEdge: 512 });
  assert.deepEqual(PERFORMANCE_BUDGET, { maxTextures: 12, maxBytes: 32 * 1024 * 1024, maxEdge: 256 });
  assert.deepEqual([...EDGE_LADDER], [512, 256, 128]);
});

test("pickLadderEdge：GPU 上限逐级下探", () => {
  assert.equal(pickLadderEdge(4096, 512), 512);
  assert.equal(pickLadderEdge(512, 512), 512);
  assert.equal(pickLadderEdge(300, 512), 256); // 阶梯取 ≤GPU 上限的最大档
  assert.equal(pickLadderEdge(2048, 512), 512);
  assert.equal(pickLadderEdge(200, 512), 128);
});

test("超级性能模式预算减半生效（setSuperPerformance）", () => {
  const cache = new CoverTextureCache(fakeRenderer);
  assert.equal(cache.superPerformanceBudget, false);
  assert.equal(cache.targetEdge, 512);
  cache.setSuperPerformance(true);
  assert.equal(cache.superPerformanceBudget, true);
  assert.equal(cache.targetEdge, 256);
  cache.setSuperPerformance(false);
  assert.equal(cache.targetEdge, 512);
  cache.dispose();
});

test("acquire：空 key/非 sha1 一律 null（未命中保持素面，绝不上白块）", async () => {
  const cache = new CoverTextureCache(fakeRenderer);
  assert.equal(await cache.acquire(null), null);
  assert.equal(await cache.acquire(undefined), null);
  assert.equal(await cache.acquire("not-a-sha1-key"), null);
  cache.dispose();
  assert.equal(await cache.acquire("sha1:abc"), null, "dispose 后一律 null");
});

test("normalizeUserMode 三态收敛（未知值 → textures）", () => {
  for (const mode of USER_MODES) assert.equal(normalizeUserMode(mode), mode);
  assert.equal(normalizeUserMode("bogus"), "textures");
  assert.equal(normalizeUserMode(null), "textures");
});

test("降级条件 3：MAX_TEXTURE_SIZE < 2048 → gpuLimit（一次性硬件判定）", () => {
  const d = new CoverDegrader({
    textures: () => 10,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 1024,
    cache: () => null,
  });
  const s = d.evaluate(0);
  assert.equal(s.effective, "off");
  assert.equal(s.reason, "gpuLimit");
  assert.match(DEGRADE_REASONS.gpuLimit, /2048/);
});

test("降级条件 5：用户显式 off（reason=userOff，非自动降级）", () => {
  const d = new CoverDegrader({
    textures: () => 10,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 4096,
    cache: () => null,
  });
  d.setUserMode("off");
  const s = d.evaluate(1000);
  assert.equal(s.effective, "off");
  assert.equal(s.autoDegrading, false);
  assert.equal(s.reason, "userOff");
});

test("降级条件 4：封面通路连续失败 ≥12 → hostFailed", () => {
  const cache = { consecutiveFailures: 12 };
  const d = new CoverDegrader({
    textures: () => 5,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 4096,
    cache: () => cache,
  });
  const s = d.evaluate(1000);
  assert.equal(s.effective, "off");
  assert.equal(s.reason, "hostFailed");
});

test("降级条件 1：60s 稳态纹理净增 ≥16 且 ≥90% 步不减 → textureLeak；正常轮换不误报", () => {
  let count = 8;
  const d = new CoverDegrader({
    textures: () => count,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 4096,
    cache: () => null,
  });
  // 泄漏：每秒 +1，跑满窗口。
  for (let t = 0; t < 62; t++) {
    count += 1;
    const s = d.evaluate(t * 1000);
    if (t >= 56 && s.autoDegrading) {
      assert.equal(s.reason, "textureLeak");
      break;
    }
    if (t === 61) assert.fail("泄漏序列未在窗口内触发 textureLeak");
  }
  // 对照组：LRU 上限内振荡（±1）不得误报。
  let osc = 24;
  const d2 = new CoverDegrader({
    textures: () => osc,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 4096,
    cache: () => null,
  });
  for (let t = 0; t < 120; t++) {
    osc = 24 + (t % 3 === 0 ? -1 : 0);
    assert.equal(d2.evaluate(t * 1000).autoDegrading, false, `t=${t} 不应误报泄漏`);
  }
});

test("降级条件 2：帧中位 >33ms 且关纹理对照 ≤22.2ms → frameBudget；无对照不触发", () => {
  const mk = (control) =>
    new CoverDegrader({
      textures: () => 10,
      frameMedianMs: () => 40,
      frameMedianMsNoCover: () => control,
      maxTextureSize: () => 4096,
      cache: () => null,
    });
  assert.equal(mk(null).evaluate(1000).autoDegrading, false, "无对照测量不误杀（开机噪声纪律）");
  assert.equal(mk(40).evaluate(1000).autoDegrading, false, "关闭封面也不快 → 非纹理成本");
  const hit = mk(16).evaluate(1000);
  assert.equal(hit.effective, "off");
  assert.equal(hit.reason, "frameBudget");
});

test("滞回：自动降级粘滞，只有用户 setUserMode 恢复", () => {
  const d = new CoverDegrader({
    textures: () => 10,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 1024, // 恒触发 gpuLimit
    cache: () => null,
  });
  d.evaluate(0);
  assert.equal(d.state.autoDegrading, true);
  assert.equal(d.state.effective, "off");
  // setUserMode = 唯一恢复通道（即便硬件条件仍差，用户意志优先，条件会在下一次 evaluate 再判）。
  d.setUserMode("selected");
  assert.equal(d.state.autoDegrading, false);
  assert.equal(d.state.effective, "selected");
  assert.equal(d.evaluate(5000).reason, "gpuLimit", "evaluate 后重新判定并再次粘滞");
});

test("forceDegrade 稳态钩子（CDP 验收 5 用）", () => {
  const d = new CoverDegrader({
    textures: () => 10,
    frameMedianMs: () => 16,
    frameMedianMsNoCover: () => null,
    maxTextureSize: () => 4096,
    cache: () => null,
  });
  const s = d.forceDegrade("textureLeak");
  assert.equal(s.effective, "off");
  assert.equal(s.reason, "textureLeak");
});
