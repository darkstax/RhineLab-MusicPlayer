// ring.h — 无锁 SPSC 环形缓冲（帧颗粒，交错 s32 容器 = i16<<16 / i24<<8 / i32）。
// 元素类型用 int32 而非 float 的原因：24bit 红线（AUDIO-ENGINE §4 / 任务书约束 3）——
// 解码输出必须是整型容器，ring 若为 f32 则核心内部链路在解码段就 float 化了，徽章失真。
// 生产者 = 解码线程；消费者 = 音频回调线程（回调内零分配、零锁）。
// 容量构造时固定（动态环 = 重分配风险，违反回调零分配纪律）。
// 内存序：write 用 release、read 对侧用 acquire，经典 SPSC。
// 声道数固定 2（立体声交错）；单声道/多声道源在解码段对齐为 2（记入 chain 因子）。
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <vector>

namespace rhine {

class SpscRing {
public:
    // capacityFrames 向上取到 2 的幂（掩码取模）。
    explicit SpscRing(std::size_t capacityFrames);

    // 写入至多 n 帧；返回实际写入帧数（满时小于 n）。
    std::size_t push(const std::int32_t* data, std::size_t n);
    // 读出至多 n 帧；返回实际读出帧数（不足时读出全部可读帧 = 欠载剩余由调用方补静音）。
    std::size_t pop(std::int32_t* data, std::size_t n);
    // 非消费 peek：从可读数据的第 skip 帧起拷贝（M3 频谱 tap 预留，不前进读指针）。
    std::size_t peek(std::size_t skip, std::int32_t* data, std::size_t n) const;
    std::size_t readable() const;
    std::size_t capacity_frames() const { return mask_ + 1; }
    // 仅允许在无并发消费者活动时调用（seek/stop：先停喂（Quiesce）再清；回调不 pop 时安全）。
    void reset();

private:
    std::size_t mask_;
    std::vector<std::int32_t> buf_;  // 每帧 2 个 int32
    std::atomic<std::size_t> head_{0};  // 写指针（生产者独占推进）
    std::atomic<std::size_t> tail_{0};  // 读指针（消费者独占推进）
};

}  // namespace rhine
