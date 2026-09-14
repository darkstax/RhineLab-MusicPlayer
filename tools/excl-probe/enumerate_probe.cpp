#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#define MA_NO_ENGINE
#define MA_NO_EFFECTS
#include "miniaudio.h"
#include <cstdio>

int main() {
    ma_context ctx{};
    if (ma_context_init(nullptr, 0, nullptr, &ctx) != MA_SUCCESS) { printf("ctx fail\n"); return 1; }
    ma_device_info* pb = nullptr; ma_uint32 pbc = 0;
    ma_device_info* cp = nullptr; ma_uint32 cpc = 0;
    ma_context_get_devices(&ctx, &pb, &pbc, &cp, &cpc);
    for (ma_uint32 i = 0; i < pbc; ++i) {
        printf("== %s default=%d formats=%u\n", pb[i].name, pb[i].isDefault, pb[i].nativeDataFormatCount);
        for (ma_uint32 f = 0; f < pb[i].nativeDataFormatCount; ++f) {
            auto& df = pb[i].nativeDataFormats[f];
            printf("   fmt=%d ch=%u rate=%u flags=0x%x\n", (int)df.format, df.channels, df.sampleRate, df.flags);
        }
    }
    ma_context_uninit(&ctx);
    return 0;
}
