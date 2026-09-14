// fft-equiv driver — M5a 技术债归还 A2 验收（一次性对照，可常驻回归）。
//
// 用法：g++ driver.cpp <spectrum.cpp> <protocol.cpp> <kiss_fft.c> <kiss_fftr.c>
//   改前 = tools/fft-equiv/baseline/spectrum_old.{h,cpp}（重命名为 spectrum.h/cpp 的 build-old），
//   改后 = 仓库现版 src/spectrum.cpp + vendor kissfft（build-new）。
// 同一批输入帧（静音 / FLAC24 真实采样 / MP3 真实采样，s32 交错立体声）喂 SpectrumTap，
// 模拟时钟每帧 +33ms，产 100 帧 payload JSONL 到 stdout；对照脚本（equiv-check.mjs）
// 比对两份产物：max|Δband| < 1e-4 且 low/mid/high/activity/beat_phase 逐帧相等。
//
// 非 Windows 构建依赖 shim/windows.h（GetTickCount64 → 模拟时钟）。
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

#include "spectrum.h"

// —— 模拟时钟（shim/windows.h 声明的 extern "C" 符号）——
static unsigned long long g_fakeTicksMs = 0;
extern "C" unsigned long long GetTickCount64(void) { return g_fakeTicksMs; }

namespace {

struct InputSet {
    const char* name;
    std::vector<std::int32_t> s32;  // 交错立体声帧（2ch）
    std::uint32_t rate;
};

std::vector<std::int32_t> ReadS32Le(const std::string& path) {
    std::vector<std::int32_t> out;
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) {
        fprintf(stderr, "fft-equiv: cannot open %s\n", path.c_str());
        exit(2);
    }
    fseek(f, 0, SEEK_END);
    const long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    out.resize(static_cast<std::size_t>(size) / sizeof(std::int32_t));
    if (!out.empty() && fread(out.data(), sizeof(std::int32_t), out.size(), f) != out.size()) {
        fprintf(stderr, "fft-equiv: short read %s\n", path.c_str());
        exit(2);
    }
    fclose(f);
    return out;
}

// 从 PCM 流的第 skipBytes 起取 frames 帧（不足则回绕——对照用确定性输入，允许重复段）。
std::vector<std::int32_t> Slice(const std::vector<std::int32_t>& pcm, std::size_t startFrame,
                                std::size_t wantFrames) {
    const std::size_t total = pcm.size() / 2;
    std::vector<std::int32_t> out;
    out.reserve(wantFrames * 2);
    for (std::size_t i = 0; i < wantFrames; ++i) {
        const std::size_t src = total == 0 ? 0 : (startFrame + i) % total;
        out.push_back(pcm[src * 2]);
        out.push_back(pcm[src * 2 + 1]);
    }
    return out;
}

}  // namespace

int main(int argc, char** argv) {
    // argv[1] = FLAC 路径（s32le 交错 2ch 48k，由脚本 ffmpeg 预转），argv[2] = MP3 同形，
    // argv[3] = 输出 jsonl 路径。静音集无需外部文件。
    if (argc < 4) {
        fprintf(stderr, "usage: fft-equiv <flac.s32> <mp3.s32> <out.jsonl>\n");
        return 2;
    }
    const std::vector<std::int32_t> flac = ReadS32Le(argv[1]);
    const std::vector<std::int32_t> mp3 = ReadS32Le(argv[2]);
    constexpr std::uint32_t kRate = 48000;
    constexpr std::size_t kWindow = 1024;
    constexpr std::size_t kCommit = 512;
    constexpr int kFramesPerSet = 40;  // 每组 40 帧，三组（静音/flac24/mp3）合计 120（>100 验收线）

    std::vector<InputSet> sets;
    {
        InputSet silence{
            "silence", std::vector<std::int32_t>(kCommit * kFramesPerSet * 2, 0), kRate};
        sets.push_back(std::move(silence));
    }
    {
        InputSet s{"flac24", Slice(flac, kWindow * 7, kCommit * static_cast<std::size_t>(kFramesPerSet)), kRate};
        sets.push_back(std::move(s));
    }
    {
        InputSet s{"mp3", Slice(mp3, kWindow * 13, kCommit * static_cast<std::size_t>(kFramesPerSet)), kRate};
        sets.push_back(std::move(s));
    }

    FILE* out = fopen(argv[3], "wb");
    if (!out) { fprintf(stderr, "fft-equiv: cannot write %s\n", argv[3]); return 2; }

    rhine::SpectrumTap tap;
    tap.SetEnabled(true);
    for (auto& set : sets) {
        tap.Reset();
        const std::size_t chunks = set.s32.size() / (kCommit * 2);
        for (std::size_t c = 0; c < chunks; ++c) {
            tap.PushFromCallback(set.s32.data() + c * kCommit * 2, kCommit, set.rate);
            g_fakeTicksMs += 17;  // 半帧节拍推进（512 帧 @48k ≈ 10.7ms）
            auto payload = tap.AnalyzeFrame();
            g_fakeTicksMs += 16;
            payload["set"] = set.name;
            payload["frame"] = static_cast<std::int64_t>(c);
            fprintf(out, "%s\n", payload.dump().c_str());
        }
    }
    fclose(out);
    fprintf(stderr, "fft-equiv: wrote %s\n", argv[3]);
    return 0;
}
