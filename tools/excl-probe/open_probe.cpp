#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_ENGINE
#define MA_NO_EFFECTS
#include "miniaudio.h"
#include <cstdio>

static void Try(const char* label, ma_format fmt, ma_uint32 rate) {
    ma_context ctx{};
    if (ma_context_init(nullptr, 0, nullptr, &ctx) != MA_SUCCESS) { printf("ctx fail\n"); return; }
    ma_device_config cfg = ma_device_config_init(ma_device_type_playback);
    cfg.playback.format = fmt;
    cfg.playback.channels = 2;
    cfg.sampleRate = rate;
    cfg.playback.shareMode = ma_share_mode_exclusive;
    cfg.periodSizeInMilliseconds = 5;
    cfg.periods = 2;
    cfg.dataCallback = [](ma_device*, void* out, const void*, ma_uint32 f) {
        // 按最小公分母清（s16=2B/声道）：多清会在 s16 设备缓冲上越界（上一版崩溃根因）。
        ZeroMemory(out, f * 2 * 2);
    };
    ma_device dev{};
    ma_result rc = ma_device_init(&ctx, &cfg, &dev);
    printf("%-22s init=%d", label, (int)rc);
    if (rc == MA_SUCCESS) {
        printf(" got: fmt=%d rate=%u period=%u", (int)dev.playback.format, dev.sampleRate,
               dev.playback.internalPeriodSizeInFrames);
        rc = ma_device_start(&dev);
        printf(" start=%d", (int)rc);
        Sleep(200);
        ma_device_uninit(&dev);
    }
    printf("\n");
    fflush(stdout);
    ma_context_uninit(&ctx);
}

int main() {
    Try("exclusive s32@48000", ma_format_s32, 48000);
    Try("exclusive s16@44100", ma_format_s16, 44100);
    Try("exclusive s32@96000", ma_format_s32, 96000);
    Try("exclusive f32@48000", ma_format_f32, 48000);
    Try("exclusive s32@44100", ma_format_s32, 44100);
    return 0;
}
