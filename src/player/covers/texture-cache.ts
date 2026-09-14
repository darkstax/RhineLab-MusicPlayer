import * as THREE from "three";

/**
 * 封面纹理管线（M5d，M5-PLAN-v2 §5.4）：cover_key → cover.rhine.local 虚拟主机
 * → 浏览器解码（fetch+blob+createImageBitmap）→ OffscreenCanvas 降采样阶梯 →
 * THREE.CanvasTexture，LRU 预算缓存。**不跨进程传像素、零 IPC 载荷**。
 *
 * 预算（标准 / 超级性能）：
 * - 标准：maxTextures 24、maxBytes 96 MiB、阶梯 512²；
 * - 超级性能：maxTextures 12、maxBytes 32 MiB、阶梯 256²（直接压半）。
 * GPU 上限（MAX_TEXTURE_SIZE）低于阶梯时逐级下探 512→256→128。
 *
 * 纪律：
 * - 未命中/加载中保持素面（调用方拿 null 就不贴图，绝不上白块）；
 * - 解码/取回失败：负缓存（TTL 内不再重试）+ 计入 pipeline 失败观测（degrade 条件 4）；
 * - 驱逐必须 dispose 纹理（否则 renderer.info.memory.textures 只增不减 = 验收 5 泄漏）；
 * - 引用计数：选中卡持有期间不得被驱逐（release 后回到 LRU 池）。
 */

export type CoverBudget = {
  maxTextures: number;
  maxBytes: number;
  maxEdge: number;
};

export const STANDARD_BUDGET: CoverBudget = {
  maxTextures: 24,
  maxBytes: 96 * 1024 * 1024,
  maxEdge: 512,
};
export const PERFORMANCE_BUDGET: CoverBudget = {
  maxTextures: 12,
  maxBytes: 32 * 1024 * 1024,
  maxEdge: 256,
};

/** 分辨率阶梯（degrade 条件 3 的 GPU 下探序列）。 */
export const EDGE_LADDER = [512, 256, 128] as const;

const FAILURE_TTL_MS = 60_000;

type Entry = {
  key: string;
  texture: THREE.Texture;
  bytes: number;
  refs: number;
};

export type CoverCacheStats = {
  size: number;
  bytes: number;
  hits: number;
  loads: number;
  failures: number;
  evictions: number;
};

export class CoverTextureCache {
  /** 插入序 = LRU 序（get 命中会重新插入以刷新新鲜度；队首最旧）。 */
  private entries = new Map<string, Entry>();
  private inflight = new Map<string, Promise<Entry | null>>();
  private failures = new Map<string, number>();
  /** cover_key → 实测可用的扩展名（.jpg/.png 双态，M5A-FINDINGS §8.2）。 */
  private extensions = new Map<string, "jpg" | "png">();
  private budget: CoverBudget = STANDARD_BUDGET;
  private gpuMaxEdge: number;
  private counters = { hits: 0, loads: 0, failures: 0, evictions: 0 };
  private disposed = false;
  /** 连续管线失败计数（fetch 全灭类），供 degrade 条件 4；成功一次即清零。 */
  public consecutiveFailures = 0;

  constructor(renderer: THREE.WebGLRenderer) {
    this.gpuMaxEdge = pickLadderEdge(
      renderer.capabilities.maxTextureSize,
      this.budget.maxEdge,
    );
  }

  get superPerformanceBudget() {
    return this.budget.maxTextures === PERFORMANCE_BUDGET.maxTextures;
  }

  setSuperPerformance(enabled: boolean) {
    this.budget = enabled ? PERFORMANCE_BUDGET : STANDARD_BUDGET;
    this.gpuMaxEdge = pickLadderEdge(this.maxTextureSizeHint, this.budget.maxEdge);
    this.evict();
  }

  /** GPU 阶梯下探（degrade 条件 3：MAX_TEXTURE_SIZE < 2048 或 512² 被拒）。 */
  setMaxTextureSize(maxSize: number) {
    this.maxTextureSizeHint = maxSize;
    this.gpuMaxEdge = pickLadderEdge(maxSize, this.budget.maxEdge);
  }
  private maxTextureSizeHint = 4096;

  get targetEdge() {
    return Math.min(this.budget.maxEdge, this.gpuMaxEdge);
  }

  /**
   * 取纹理（引用计数 +1）。返回 null = 未命中且加载失败/被禁用；调用方保留 release。
   * 同 key 并发合流（inflight 去重）。
   */
  async acquire(
    coverKey: string | null | undefined,
  ): Promise<{ texture: THREE.Texture; release: () => void } | null> {
    if (this.disposed || !coverKey) return null;
    const cached = this.entries.get(coverKey);
    if (cached) {
      this.counters.hits++;
      this.touch(cached);
      cached.refs++;
      return this.holding(cached);
    }
    const failedAt = this.failures.get(coverKey);
    if (failedAt !== undefined && Date.now() - failedAt < FAILURE_TTL_MS)
      return null;
    let pending = this.inflight.get(coverKey);
    if (!pending) {
      pending = this.load(coverKey).finally(() => this.inflight.delete(coverKey));
      this.inflight.set(coverKey, pending);
    }
    const entry = await pending;
    if (!entry || this.disposed) return null;
    // 等待期间可能已被驱逐：entry 不在表中则放弃（交 GC）。
    if (!this.entries.has(entry.key)) {
      entry.texture.dispose();
      return null;
    }
    entry.refs++;
    return this.holding(entry);
  }

  private holding(entry: Entry) {
    let released = false;
    return {
      texture: entry.texture,
      release: () => {
        if (released) return;
        released = true;
        entry.refs = Math.max(0, entry.refs - 1);
      },
    };
  }

  /** 预热（选中卡 ±2 预取用）：只入缓存不持引用。 */
  prefetch(coverKey: string | null | undefined) {
    if (!coverKey || this.entries.has(coverKey) || this.inflight.has(coverKey))
      return;
    void this.acquire(coverKey).then((held) => held?.release());
  }

  get memoryBytes() {
    let sum = 0;
    for (const entry of this.entries.values()) sum += entry.bytes;
    return sum;
  }

  getSnapshot(): CoverCacheStats & { gpuTextures: number } {
    return {
      size: this.entries.size,
      bytes: this.memoryBytes,
      ...this.counters,
      gpuTextures: this.entries.size,
    };
  }

  dispose() {
    this.disposed = true;
    for (const entry of this.entries.values()) entry.texture.dispose();
    this.entries.clear();
    this.inflight.clear();
    this.failures.clear();
    this.extensions.clear();
  }

  private touch(entry: Entry) {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private evict() {
    for (const [key, entry] of this.entries) {
      if (
        this.entries.size <= this.budget.maxTextures &&
        this.memoryBytes <= this.budget.maxBytes
      )
        break;
      if (entry.refs > 0) continue; // 持有中不驱逐
      this.entries.delete(key);
      entry.texture.dispose();
      this.counters.evictions++;
    }
  }

  private async load(key: string): Promise<Entry | null> {
    this.counters.loads++;
    const edge = this.targetEdge;
    try {
      const blob = await this.fetchImage(key);
      if (!blob) {
        this.failures.set(key, Date.now());
        this.counters.failures++;
        this.consecutiveFailures++;
        return null;
      }
      const bitmap = await createImageBitmap(blob, {
        imageOrientation: "from-image",
      });
      const scaled = Math.min(edge, bitmap.width, bitmap.height);
      // 阶梯降采样（512² 预算；源图更小则不放大）。
      const canvas = new OffscreenCanvas(scaled, scaled);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2d context unavailable");
      context.drawImage(bitmap, 0, 0, scaled, scaled);
      bitmap.close();
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = true;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.anisotropy = this.anisotropy;
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      const entry: Entry = {
        key,
        texture,
        bytes: scaled * scaled * 4,
        refs: 0,
      };
      this.entries.set(key, entry);
      this.consecutiveFailures = 0;
      this.evict();
      return this.entries.has(key) ? entry : null;
    } catch {
      this.failures.set(key, Date.now());
      this.counters.failures++;
      this.consecutiveFailures++;
      return null;
    }
  }

  /** cover_key（"sha1:<hex>"）→ 虚拟主机字节流；扩展名双探测后记住。 */
  private async fetchImage(key: string): Promise<Blob | null> {
    if (!key.startsWith("sha1:")) return null;
    const base = `https://cover.rhine.local/${key.replace(":", "-")}`;
    const known = this.extensions.get(key);
    const order: Array<"jpg" | "png"> = known
      ? [known]
      : ["jpg", "png"];
    for (const ext of order) {
      try {
        const response = await fetch(`${base}.${ext}`, {
          mode: "cors",
          cache: "force-cache",
        });
        if (!response.ok) continue;
        const blob = await response.blob();
        if (!blob || blob.size === 0) continue;
        this.extensions.set(key, ext);
        return blob;
      } catch {
        continue;
      }
    }
    return null;
  }

  private anisotropyHint = 4;
  /** 与各向异性设置对齐（applyTextureQuality 同口径：≤quality.anisotropy ≤ GPU 上限）。 */
  configureAnisotropy(qualityAnisotropy: number, maxAnisotropy: number) {
    this.anisotropyHint = Math.max(
      1,
      Math.min(qualityAnisotropy, maxAnisotropy),
    );
    for (const entry of this.entries.values()) {
      if (entry.texture.anisotropy === this.anisotropyHint) continue;
      entry.texture.anisotropy = this.anisotropyHint;
      entry.texture.needsUpdate = true;
    }
  }
  private get anisotropy() {
    return this.anisotropyHint;
  }
}

/** 阶梯选择：不大于预算 maxEdge 且不大于 GPU 上限的最大档位。 */
export function pickLadderEdge(maxTextureSize: number, maxEdge: number): number {
  for (const edge of EDGE_LADDER)
    if (edge <= maxEdge && edge <= maxTextureSize) return edge;
  return 128;
}
