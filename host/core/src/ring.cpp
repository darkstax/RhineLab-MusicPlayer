// ring.cpp — SPSC 环形缓冲实现（帧颗粒，交错 s32，固定 2 声道）。
#include "ring.h"

#include <cstring>

namespace rhine {
namespace {

std::size_t RoundUpPow2(std::size_t v) {
    std::size_t p = 8;  // 最小 8 帧，避免 0 容量环。
    while (p < v) p <<= 1;
    return p;
}

constexpr std::size_t kFrameWords = 2;  // 立体声交错

}  // namespace

SpscRing::SpscRing(std::size_t capacityFrames) {
    const std::size_t cap = RoundUpPow2(capacityFrames);
    mask_ = cap - 1;
    buf_.assign(cap * kFrameWords, 0);
}

std::size_t SpscRing::push(const std::int32_t* data, std::size_t n) {
    const std::size_t head = head_.load(std::memory_order_relaxed);
    const std::size_t tail = tail_.load(std::memory_order_acquire);
    const std::size_t freeFrames = (mask_ + 1) - (head - tail);
    const std::size_t toWrite = n < freeFrames ? n : freeFrames;
    if (toWrite == 0) return 0;

    const std::size_t first = (mask_ + 1) - (head & mask_);
    const std::size_t partA = toWrite < first ? toWrite : first;
    std::memcpy(buf_.data() + (head & mask_) * kFrameWords, data, partA * kFrameWords * sizeof(std::int32_t));
    if (toWrite > partA) {
        std::memcpy(buf_.data(), data + partA * kFrameWords,
                    (toWrite - partA) * kFrameWords * sizeof(std::int32_t));
    }
    head_.store(head + toWrite, std::memory_order_release);
    return toWrite;
}

std::size_t SpscRing::pop(std::int32_t* data, std::size_t n) {
    const std::size_t tail = tail_.load(std::memory_order_relaxed);
    const std::size_t head = head_.load(std::memory_order_acquire);
    const std::size_t avail = head - tail;
    const std::size_t toRead = n < avail ? n : avail;
    if (toRead == 0) return 0;

    const std::size_t first = (mask_ + 1) - (tail & mask_);
    const std::size_t partA = toRead < first ? toRead : first;
    std::memcpy(data, buf_.data() + (tail & mask_) * kFrameWords,
                partA * kFrameWords * sizeof(std::int32_t));
    if (toRead > partA) {
        std::memcpy(data + partA * kFrameWords, buf_.data(),
                    (toRead - partA) * kFrameWords * sizeof(std::int32_t));
    }
    tail_.store(tail + toRead, std::memory_order_release);
    return toRead;
}

std::size_t SpscRing::peek(std::size_t skip, std::int32_t* data, std::size_t n) const {
    const std::size_t tail = tail_.load(std::memory_order_acquire);
    const std::size_t head = head_.load(std::memory_order_acquire);
    const std::size_t avail = head - tail;
    if (skip >= avail) return 0;
    const std::size_t start = tail + skip;
    std::size_t toRead = avail - skip;
    if (toRead > n) toRead = n;

    const std::size_t first = (mask_ + 1) - (start & mask_);
    const std::size_t partA = toRead < first ? toRead : first;
    std::memcpy(data, buf_.data() + (start & mask_) * kFrameWords,
                partA * kFrameWords * sizeof(std::int32_t));
    if (toRead > partA) {
        std::memcpy(data + partA * kFrameWords, buf_.data(),
                    (toRead - partA) * kFrameWords * sizeof(std::int32_t));
    }
    return toRead;
}

std::size_t SpscRing::readable() const {
    const std::size_t head = head_.load(std::memory_order_acquire);
    const std::size_t tail = tail_.load(std::memory_order_acquire);
    return head - tail;
}

void SpscRing::reset() {
    tail_.store(0, std::memory_order_relaxed);
    head_.store(0, std::memory_order_release);
}

}  // namespace rhine
