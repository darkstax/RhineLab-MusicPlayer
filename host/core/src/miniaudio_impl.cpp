// miniaudio_impl.cpp — MINIAUDIO_IMPLEMENTATION 独立编译单元。
// miniaudio 是单头文件库；把实现宏隔离到本 TU 后，业务代码改一行不再重编 miniaudio
// （全量编译约 2-4 分钟，单独成 TU 后增量编译只需重编业务文件）。
// MA_NO_ENGINE/MA_NO_EFFECTS/MA_NO_ENCODING/MA_NO_GENERATION：本核心只用
// ma_device + ma_decoder（AUDIO-ENGINE v1 解码集 FLAC/MP3/WAV 即 dr_flac/dr_mp3/dr_wav，
// 默认保留），不用 ma_engine 高层图/特效/编码/信号生成，裁掉以缩短编译。
#define MINIAUDIO_IMPLEMENTATION
#define MA_NO_ENGINE
#define MA_NO_EFFECTS
#define MA_NO_ENCODING
#define MA_NO_GENERATION
#include "miniaudio.h"
