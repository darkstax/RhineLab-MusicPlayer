// main.cpp — RhineCore（M2 C++ 音频核心）：命名管道 server + JSON Lines 帧循环。
// 结构对照 RhineCoreStub/Program.cs（协议裁判，永久保留）：
//   · 单实例：管道名即互斥（CreateNamedPipe 失败 → exit 3，桩同款）；
//   · 会话：握手（3s）→ 读循环 + 1Hz tick → bye/EOF 结束；
//   · 退出码：0 有序 / 3 管道占用 / 5 会话未预期异常 / 7 --kill-after（与桩对齐）。
// 命令行：RhineCore [--pipe <name>] [--trace <file>] [--verbose]
//                  [--kill-after <sec>] [--no-preopen]
// 环境变量：RHINE_CORE_PIPE（协议 §1 core.pipe 覆盖项）。
// M2 裁定（GOAL-AUTONOMY §1）：桩的 --halt-events 丢帧钩子不迁移（m1-scenario 只对桩）。
#include <windows.h>
#include <sddl.h>  // ConvertStringSecurityDescriptorToSecurityDescriptorW（ACL，协议 §10）

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <iostream>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "audio.h"
#include "engine.h"
#include "protocol.h"

namespace {

using rhine::proto::Json;

constexpr const char* kDefaultPipe = "rhine-music.core.v1";  // 不含 \\.\pipe\ 前缀
constexpr int kProto = 1;

// 协议 §5 的 M2 核心声明能力（caps 只声明已实现项；桩含 echo 属 M0 遗留测试面，
// 真核心不实现，被调用回 not_implemented）。M3：+spectrum（§5 spectrum.on/off、§6 evt 定形）。
const char* kCaps[] = {
    "engine.state", "engine.play", "engine.pause",  "engine.resume", "engine.stop",
    "engine.toggle", "engine.seek", "engine.volume", "spectrum",
    // M6（协议 v1.5）：只读数据面——设备枚举与诊断计数。
    "devices.list", "diag.get",
    // M4-a（协议 v1.6）：输出策略（独占协商/降级/升档）。devices.select 属 M4-c 不声明。
    "output.mode",
};

std::atomic<HANDLE> g_stopEvent{nullptr};
std::atomic<bool> g_shutdown{false};

void Log(const char* level, const std::string& message) {
    FILE* out = stdout;
    std::fprintf(out, "[core][%s] %s\n", level, message.c_str());
    std::fflush(out);
}

std::int64_t NowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::string WideToUtf8(const std::wstring& wide) {
    if (wide.empty()) return {};
    const int need = WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()),
                                         nullptr, 0, nullptr, nullptr);
    std::string out(static_cast<std::size_t>(need), '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide.data(), static_cast<int>(wide.size()), out.data(), need,
                        nullptr, nullptr);
    return out;
}

std::wstring Utf8ToWide(const std::string& utf8) {
    if (utf8.empty()) return {};
    const int need = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()),
                                         nullptr, 0);
    std::wstring out(static_cast<std::size_t>(need), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), need);
    return out;
}

std::string PipeNameOnly(const std::string& pipe) {
    std::string name = pipe;
    // 去空白两端。
    const auto trim = [](std::string& s) {
        std::size_t b = s.find_first_not_of(" \t\r\n");
        std::size_t e = s.find_last_not_of(" \t\r\n");
        s = b == std::string::npos ? std::string() : s.substr(b, e - b + 1);
    };
    trim(name);
    const std::string prefix = "\\\\.\\pipe\\";
    if (name.size() >= prefix.size() && _strnicmp(name.c_str(), prefix.c_str(), prefix.size()) == 0) {
        name = name.substr(prefix.size());
    }
    const std::string prefix2 = "\\\\?\\pipe\\";
    if (name.size() >= prefix2.size() && _strnicmp(name.c_str(), prefix2.c_str(), prefix2.size()) == 0) {
        name = name.substr(prefix2.size());
    }
    if (name.empty()) name = kDefaultPipe;
    return name;
}

// —— trace 落盘（桩同款：一行一条，kind + seq + ep + data；追加模式允许多进程共写一份证据）——
class TraceWriter {
public:
    bool Open(const std::string& path) {
        const std::wstring wide = Utf8ToWide(path);
        if (wide.empty()) return false;
        // 手工创建：追加 + 允许并发读。
        HANDLE h = CreateFileW(wide.c_str(), FILE_APPEND_DATA,
                               FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                               OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (h == INVALID_HANDLE_VALUE) return false;
        handle_ = h;
        return true;
    }
    void WriteLine(const std::string& line) {
        if (handle_ == nullptr) return;
        std::string data = line + "\n";
        DWORD written = 0;
        WriteFile(handle_, data.data(), static_cast<DWORD>(data.size()), &written, nullptr);
    }
    ~TraceWriter() {
        if (handle_ != nullptr) CloseHandle(handle_);
    }

private:
    HANDLE handle_ = nullptr;
};

TraceWriter g_trace;

// —— 管道 IO：字节流 + 行切分 + 整行写入 ——
class PipeIo {
public:
    explicit PipeIo(HANDLE pipe) : pipe_(pipe) {}

    HANDLE pipe() const { return pipe_; }

    // 读出一行（不含 '\n'）；连接断开返回 false（调用方结束会话）。
    bool ReadLine(std::string& outLine) {
        for (;;) {
            const auto nl = std::find(buf_.begin() + consumed_, buf_.end(), '\n');
            if (nl != buf_.end()) {
                outLine.assign(buf_.begin() + consumed_, nl);
                if (!outLine.empty() && outLine.back() == '\r') outLine.pop_back();
                consumed_ = static_cast<std::size_t>(nl - buf_.begin()) + 1;
                Compact();
                return true;
            }
            // 行缓冲上限 64KB（协议 §1）：超限的半行直接丢弃到下一个换行，防内存膨胀。
            buf_.resize(buf_.size() + 4096);
            DWORD got = 0;
            const BOOL ok = ReadFile(pipe_, buf_.data() + (buf_.size() - 4096), 4096, &got, nullptr);
            buf_.resize(buf_.size() - 4096 + (ok ? got : 0));
            if (!ok || got == 0) return false;
            if (buf_.size() - consumed_ > 70u * 1024) {
                // 非法超长半行：丢弃已读部分（对端自家壳，出现即对方 bug；只保不崩）。
                Log("warn", "overlong line (>70KB) — buffer dropped");
                buf_.clear();
                consumed_ = 0;
            }
        }
    }

    // 带超时的阻塞式读一行（握手用）：true = 读到一行；false = 超时或对端断开。
    // ReadLine 是阻塞语义，对端只连不发时会挂死；桩用 CancellationToken 实现同一语义。
    bool ReadLineTimeout(std::string& outLine, DWORD timeoutMs) {
        const ULONGLONG deadline = GetTickCount64() + timeoutMs;
        for (;;) {
            if (HasBufferedLine()) return ReadLine(outLine);
            DWORD avail = 0;
            if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &avail, nullptr)) return false;
            if (avail > 0) {
                char tmp[4096];
                const DWORD want = avail < 4096 ? avail : 4096;
                DWORD got = 0;
                if (!ReadFile(pipe_, tmp, want, &got, nullptr) || got == 0) return false;
                buf_.insert(buf_.end(), tmp, tmp + got);
                if (buf_.size() - consumed_ > 70u * 1024) return false;  // 超长半行 = 非法对端
                continue;
            }
            if (GetTickCount64() >= deadline) return false;
            if (g_shutdown.load(std::memory_order_relaxed)) return false;
            Sleep(10);
        }
    }

    bool WriteLine(const std::string& line) {
        std::string data = line + "\n";
        std::size_t offset = 0;
        while (offset < data.size()) {
            DWORD written = 0;
            const std::size_t chunk = data.size() - offset > 65536 ? 65536 : data.size() - offset;
            if (!WriteFile(pipe_, data.data() + offset, static_cast<DWORD>(chunk), &written,
                           nullptr) ||
                written == 0) {
                return false;
            }
            offset += written;
        }
        return true;
    }

    void WaitReadable(DWORD timeoutMs) {
        OVERLAPPED ov{};
        ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        DWORD result = 0;
        PeekNamedPipe(pipe_, nullptr, 0, nullptr, &result, nullptr);
        if (result == 0) {
            // 阻塞等待数据或断开（1ms 片轮询 + stop 事件，避免 CancelIoEx 竞态）。
            const ULONGLONG deadline = GetTickCount64() + timeoutMs;
            while (GetTickCount64() < deadline) {
                if (g_shutdown.load(std::memory_order_relaxed) ||
                    WaitForSingleObject(g_stopEvent.load(std::memory_order_relaxed), 0) ==
                        WAIT_OBJECT_0) {
                    break;
                }
                DWORD avail = 0;
                if (!PeekNamedPipe(pipe_, nullptr, 0, nullptr, &avail, nullptr)) break;
                if (avail > 0) break;
                Sleep(2);
            }
        }
        if (ov.hEvent) CloseHandle(ov.hEvent);
    }

    bool HasBufferedLine() const {
        return std::find(buf_.begin() + consumed_, buf_.end(), '\n') != buf_.end();
    }

private:
    void Compact() {
        if (consumed_ > 8192 && consumed_ * 2 > buf_.size()) {
            buf_.erase(buf_.begin(), buf_.begin() + static_cast<std::ptrdiff_t>(consumed_));
            consumed_ = 0;
        }
    }

    HANDLE pipe_;
    std::vector<char> buf_;
    std::size_t consumed_ = 0;
};

// —— 会话 ——
class Session {
public:
    Session(HANDLE pipe, rhine::AudioBackend& audio, rhine::Engine& engine,
            std::atomic<std::int64_t>& seq, std::atomic<std::int64_t>& epoch)
        : io_(pipe), audio_(audio), engine_(engine), seq_(seq), epoch_(epoch) {}

    void SetVerbose(bool verbose) { verbose_ = verbose; }

    // 返回 true = 请求进程有序退出（bye）。
    bool Run() {
        if (!Handshake()) return orderly_;
        // 协议 §9：连接建立后读循环 + 1Hz tick；单线程串行（读用 50ms 等待片轮询 tick）。
        auto nextTick = std::chrono::steady_clock::now() + std::chrono::seconds(1);
        for (;;) {
            if (g_shutdown.load(std::memory_order_relaxed)) return orderly_;
            std::string line;
            // 带超时的读：超时返回后继续 tick 循环；EOF 则结束会话。
            if (!ReadLineWithIdle(line, nextTick)) return orderly_;
            if (HandleFrame(line)) return true;
        }
    }

private:
    // 读一行，期间到点就发 tick 事件；EOF → false。
    bool ReadLineWithIdle(std::string& outLine, std::chrono::steady_clock::time_point& nextTick) {
        for (;;) {
            const auto now = std::chrono::steady_clock::now();
            if (now >= nextTick) {
                TickOnce();
                nextTick = now + std::chrono::seconds(1);
            }
            MaybeEmitSpectrum(now);
            if (io_.HasBufferedLine()) {
                return io_.ReadLine(outLine);
            }
            // 订阅期内用更短等待片保证 30Hz 节拍（协议 §6）；未订阅维持 50ms 原节奏。
            io_.WaitReadable(audio_.spectrum().enabled() ? 10 : 50);
            // WaitReadable 返回后无论有无数据都回到循环顶（重查 shutdown / tick）。
            // 若管道已断开，ReadLine 将在下一次进入时返回 false —— 这里显式探测：
            DWORD avail = 0;
            if (!PeekNamedPipe(io_.pipe(), nullptr, 0, nullptr, &avail, nullptr)) {
                return false;  // 对端断开
            }
            if (avail > 0) {
                return io_.ReadLine(outLine);
            }
            if (g_shutdown.load(std::memory_order_relaxed)) return false;
        }
    }

    // M3：频谱 30Hz 节拍（会话线程内串行发射，不加新线程/写互斥量——红线 A1 的另一半：
    // 聚合全在此线程，回调侧只 memcpy）。订阅开启才有帧；会话结束即停订阅。
    void MaybeEmitSpectrum(std::chrono::steady_clock::time_point now) {
        if (!audio_.spectrum().enabled()) {
            nextSpectrum_ = now;  // 关闭时追平，重开后立即有帧
            return;
        }
        if (now < nextSpectrum_) return;
        // 追赶保护：管道卡顿时不积帧——落后超 200ms（≈6 帧）则丢弃到期节拍，
        // 从当前时间重建节奏（接收端看到的是帧间隔变长，而非突发补发）。
        const auto period = std::chrono::milliseconds(33);  // 30Hz
        if (now - nextSpectrum_ > std::chrono::milliseconds(200)) nextSpectrum_ = now;
        nextSpectrum_ += period;
        Emit("spectrum", audio_.spectrum().AnalyzeFrame());
    }

    void TickOnce() {
        for (auto& [kind, payload] : engine_.Tick()) {
            Emit(kind, std::move(payload));
        }
    }

    bool Handshake() {
        // 协议 §4：3s 内未完成握手 → 关闭本连接（壳会退避重连）。
        std::string line;
        if (!io_.ReadLineTimeout(line, 3000)) {
            Log("warn", "handshake timeout (3s) — closing connection");
            return false;
        }
        auto frame = Json::parse(line.begin(), line.end(), nullptr, false);
        if (frame.is_discarded() || !frame.is_object() ||
            rhine::proto::FrameType(frame).value_or("") != "hello") {
            Log("warn", "first frame is not hello — closing connection");
            return false;
        }
        const int peerProto =
            static_cast<int>(rhine::proto::SafeDouble(frame, "proto").value_or(kProto));
        const std::string peerRole = rhine::proto::SafeString(frame, "role").value_or("(none)");
        const int effective = std::min(peerProto, kProto);
        if (effective != kProto) {
            Send(rhine::proto::MakeErr(std::nullopt, "proto_mismatch",
                                       "peer proto " + std::to_string(peerProto) +
                                           ", this core speaks 1",
                                       false));
            Log("error", "proto mismatch — closing connection");
            return false;
        }
        const std::int64_t ep = epoch_.fetch_add(1, std::memory_order_acq_rel) + 1;
        Log("info", "hello from role=" + peerRole + " proto=" + std::to_string(peerProto) +
                        " ep=" + std::to_string(ep));
        Json caps = Json::array();
        for (const char* cap : kCaps) caps.push_back(cap);
        if (!Send(rhine::proto::MakeHelloCore(ep, caps))) return false;
        // 协议 §9：重连补发最新 state 快照。
        Emit("state", engine_.Snapshot());
        return true;
    }

    // 返回 true = bye（有序退出）。
    bool HandleFrame(const std::string& line) {
        if (verbose_) Log("debug", "recv " + line);
        auto parsed = rhine::proto::ParseLine(line);
        if (!parsed.has_value()) {
            // 协议 §10：非法帧 = 不崩溃 + 回 bad_request + 继续会话。
            Log("warn", "dropped unparsable frame");
            Send(rhine::proto::MakeErr(std::nullopt, "bad_request",
                                       "frame is not a JSON object", false));
            return false;
        }
        const Json& frame = *parsed;
        const std::string type = rhine::proto::FrameType(frame).value_or("");
        if (type == "cmd") {
            HandleCommand(frame);
            return false;
        }
        if (type == "bye") {
            const std::string reason = rhine::proto::SafeString(frame, "reason").value_or("(none)");
            Log("info", "bye reason=" + reason);
            // 桩同款：bye 不回帧，直接有序退出（壳发完 bye 即断线，多余帧是噪音）。
            orderly_ = true;
            return true;
        }
        if (type == "hello") {
            Log("warn", "duplicate hello ignored");
            return false;
        }
        Log("warn", "ignored unexpected frame t=" + (type.empty() ? std::string("(none)") : type));
        return false;
    }

    void HandleCommand(const Json& frame) {
        const auto id = rhine::proto::SafeString(frame, "id");
        const auto cmdOpt = rhine::proto::SafeString(frame, "cmd");
        if (!cmdOpt.has_value()) {
            Send(rhine::proto::MakeErr(id, "bad_request",
                                       "cmd frame requires string fields id and cmd", false));
            return;
        }
        const std::string& cmd = *cmdOpt;
        const Json data = frame.contains("data") && frame["data"].is_object() ? frame["data"]
                                                                              : Json::object();

        try {
            rhine::CommandOutcome outcome;
            if (cmd == "engine.state") {
                outcome.result = engine_.Snapshot();
            } else if (cmd == "engine.play") {
                const std::string trackId = rhine::proto::SafeString(data, "track_id").value_or("");
                outcome = engine_.Play(trackId, rhine::proto::SafeDouble(data, "duration_ms"),
                                       rhine::proto::SafeDouble(data, "position_ms"));
            } else if (cmd == "engine.pause") {
                outcome = engine_.Pause();
            } else if (cmd == "engine.resume") {
                outcome = engine_.Resume();
            } else if (cmd == "engine.stop") {
                outcome = engine_.Stop();
            } else if (cmd == "engine.toggle") {
                outcome = engine_.Toggle();
            } else if (cmd == "engine.seek") {
                const auto positionMs = rhine::proto::SafeInt64(data, "position_ms");
                if (!positionMs.has_value()) {
                    throw rhine::BadRequest{"engine.seek requires number position_ms"};
                }
                outcome = engine_.Seek(*positionMs);
            } else if (cmd == "engine.volume") {
                const auto mode = rhine::proto::SafeString(data, "mode");
                if (!mode.has_value()) {
                    throw rhine::BadRequest{
                        "engine.volume requires string mode (fixed/hardware/integer/float)"};
                }
                outcome = engine_.SetVolume(*mode, rhine::proto::SafeDouble(data, "value"));
            } else if (cmd == "engine.preload" || cmd == "engine.cancel_preload" ||
                       cmd == "engine.queue") {
                // §5：M2 占名未定形（gapless/预加载的边界队列在 M2b/M5 落地）。
                throw rhine::NotImplemented{"cmd '" + cmd +
                                            "' is not implemented by this M2 core"};
            } else if (cmd == "spectrum.on" || cmd == "spectrum.off") {
                // 协议 §5/§6 v1.3（M3）：订阅开关，默认 off；result {enabled}。
                // 开启时复位聚合侧（避免历史弹簧/EMA 状态泄漏到新会话），无参数。
                const bool on = cmd == "spectrum.on";
                if (on && !audio_.spectrum().enabled()) audio_.spectrum().Reset();
                audio_.spectrum().SetEnabled(on);
                outcome.result = Json{{"enabled", on}};
            } else if (cmd == "devices.list") {
                // 协议 v1.5（M6）只读面：枚举 + 共享能力；exclusive 能力字段 = null（M4 域）。
                // 无设备/context 时返回 null → 按 §5 回 not_implemented，不得假装有设备。
                Json devices = audio_.ListDevices();
                if (devices.is_null()) {
                    throw rhine::NotImplemented{
                        "cmd 'devices.list' is unavailable (no audio context/device opened)"};
                }
                outcome.result = Json{{"devices", std::move(devices)}};
            } else if (cmd == "diag.get") {
                // 协议 v1.5（M6）只读面：计数器均为现成账本（audio.h underruns/reopens）；
                // link = 当前协商事实（同 §8 结构，设备未开时为 null，与 state 快照同口径）；
                // fallback_history 属 M4 降级链域，显式 null（不得省略、不得假数据）。
                const std::int64_t periodMs =
                    audio_.device_facts().appRate != 0
                        ? std::max<std::int64_t>(
                              1, static_cast<std::int64_t>(audio_.device_facts().periodFrames) *
                                     1000 /
                                     static_cast<std::int64_t>(audio_.device_facts().appRate))
                        : 0;
                outcome.result = Json{{"underruns", audio_.underruns()},
                                      {"reopens", audio_.reopens()},
                                      {"buffer_ms_now", audio_.BufferMsNow()},
                                      {"period_ms", periodMs == 0 ? Json(nullptr) : Json(periodMs)},
                                      {"link", audio_.Negotiated()},
                                      {"fallback_history", Json(nullptr)}};
            } else if (cmd == "output.mode") {
                // M4-a（协议 v1.6）：输出策略 + 立即重开链（engine 层完整重建）。
                const auto mode = rhine::proto::SafeString(data, "mode");
                if (!mode.has_value()) {
                    throw rhine::BadRequest{
                        "output.mode requires string mode (shared/exclusive/auto)"};
                }
                outcome = engine_.SetOutputMode(
                    *mode, rhine::proto::SafeDouble(data, "buffer_ms"),
                    rhine::proto::SafeBool(data, "auto_expand_buffer"),
                    rhine::proto::SafeDouble(data, "buffer_max_ms"));
            } else if (cmd == "devices.select") {
                // M4-c 域（设备手动切换 + 热插拔监听），本批未启用。
                throw rhine::NotImplemented{"cmd '" + cmd + "' is not implemented before M4-c"};
            } else if (cmd == "echo") {
                // 桩的 M0 遗留测试面不属于真核心（caps 未声明）。
                throw rhine::NotImplemented{"cmd 'echo' is not implemented by this core"};
            } else {
                throw rhine::NotImplemented{"cmd '" + cmd + "' is not implemented"};
            }
            Send(rhine::proto::MakeAck(id, std::move(outcome.result)));
            for (auto& [kind, payload] : outcome.events) {
                Emit(kind, std::move(payload));
            }
            if (verbose_) Log("debug", "ack id=" + id.value_or("(none)") + " cmd=" + cmd);
        } catch (const rhine::BadRequest& ex) {
            Send(rhine::proto::MakeErr(id, "bad_request", ex.message, false));
            Log("warn", "bad_request id=" + id.value_or("(none)") + " cmd=" + cmd + ": " +
                            ex.message);
        } catch (const rhine::NotImplemented& ex) {
            Send(rhine::proto::MakeErr(id, "not_implemented", ex.message, false));
            Log("warn", "not_implemented id=" + id.value_or("(none)") + " cmd=" + cmd);
        } catch (const rhine::DecodeFailure& ex) {
            // §7 decode_failed：retryable=是；extra（track_id）并入 error 对象。
            Json err = rhine::proto::MakeErr(id, "decode_failed", ex.message, true);
            if (ex.extra.is_object()) {
                for (auto it = ex.extra.begin(); it != ex.extra.end(); ++it) {
                    err["error"][it.key()] = it.value();
                }
            }
            Send(err);
            Log("warn", "decode_failed id=" + id.value_or("(none)") + " cmd=" + cmd + ": " +
                            ex.message);
        } catch (const std::exception& ex) {
            Send(rhine::proto::MakeErr(id, "internal", ex.what(), false));
            Log("error", std::string("cmd handler faulted: ") + ex.what());
        } catch (...) {
            Send(rhine::proto::MakeErr(id, "internal", "unclassified engine failure", false));
            Log("error", "cmd handler faulted: unknown exception");
        }
    }

    void Emit(const std::string& kind, Json payload) {
        const std::int64_t seq = seq_.fetch_add(1, std::memory_order_acq_rel) + 1;
        const std::int64_t ep = epoch_.load(std::memory_order_acquire);
        // trace 先取 data 文本：Send 会把 payload move 进帧（move 后 dump 只会得到 null）。
        const std::string traceData =
            (kind == "state" || kind == "position")
                ? payload.dump(-1, ' ', false, Json::error_handler_t::replace)
                : std::string();
        if (!Send(rhine::proto::MakeEvt(seq, ep, kind, std::move(payload)))) {
            Log("warn", "evt write failed kind=" + kind);
            return;
        }
        if (kind == "state" || kind == "position") {
            // trace：kind + seq + ep + data（桩同款；证据链主用途 = 位置推进）。
            SYSTEMTIME st{};
            GetLocalTime(&st);
            char stamp[24];
            std::snprintf(stamp, sizeof(stamp), "%02d:%02d:%02d.%03d", st.wHour, st.wMinute,
                          st.wSecond, st.wMilliseconds);
            g_trace.WriteLine(std::string(stamp) + " evt=" + kind + " seq=" + std::to_string(seq) +
                              " ep=" + std::to_string(ep) + " data=" + traceData);
        }
    }

    bool Send(const Json& frame) { return io_.WriteLine(rhine::proto::Dump(frame)); }

    PipeIo io_;
    rhine::AudioBackend& audio_;
    rhine::Engine& engine_;  // 跨连接保留（桩同款：页面刷新/壳重连不重置播放）
    std::atomic<std::int64_t>& seq_;
    std::atomic<std::int64_t>& epoch_;
    bool orderly_ = false;
    bool verbose_ = false;
    std::chrono::steady_clock::time_point nextSpectrum_{};
};

std::wstring GetEnvWide(const wchar_t* name) {
    wchar_t buf[4096];
    const DWORD n = GetEnvironmentVariableW(name, buf, 4095);
    if (n == 0 || n > 4095) return {};
    return std::wstring(buf, n);
}

std::string ArgValue(int argc, char** argv, const char* name) {
    for (int i = 1; i + 1 < argc; ++i) {
        if (std::strcmp(argv[i], name) == 0) return argv[i + 1];
    }
    return {};
}

BOOL WINAPI ConsoleHandler(DWORD signal) {
    if (signal == CTRL_C_EVENT || signal == CTRL_CLOSE_EVENT) {
        g_shutdown.store(true, std::memory_order_release);
        HANDLE stop = g_stopEvent.load(std::memory_order_acquire);
        if (stop) SetEvent(stop);
        return TRUE;
    }
    return FALSE;
}

// 协议 §10：管道 ACL = 仅当前用户可连。SDDL 没有「当前登录用户」的简写
// （SU 是服务登录组 S-1-5-6，IU 是所有交互会话，都不是“本用户”），.NET 的
// PipeOptions.CurrentUserOnly 实际也是按令牌动态构造。这里取本进程令牌的
// User SID 拼 SDDL（+ SY/BA 与 .NET 实现同构），配合 PIPE_REJECT_REMOTE_CLIENTS。
std::wstring BuildPipeSddl() {
    std::wstring sddl = L"D:(A;;GA;;;SY)(A;;GA;;;BA)";
    HANDLE token = nullptr;
    if (OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
        DWORD len = 0;
        GetTokenInformation(token, TokenUser, nullptr, 0, &len);
        std::vector<char> buf(len);
        if (len > 0 && GetTokenInformation(token, TokenUser, buf.data(), len, &len)) {
            auto* user = reinterpret_cast<TOKEN_USER*>(buf.data());
            LPWSTR sidText = nullptr;
            if (ConvertSidToStringSidW(user->User.Sid, &sidText)) {
                sddl = L"D:(A;;GA;;;" + std::wstring(sidText) + L")" + sddl.substr(2);
                LocalFree(sidText);
            }
        }
        CloseHandle(token);
    }
    return sddl;
}

}  // namespace

int main(int argc, char** argv) {
    if (argc > 1 && (std::strcmp(argv[1], "--help") == 0 || std::strcmp(argv[1], "-h") == 0)) {
        std::printf(
            "RhineCore — M2 audio core (IPC protocol v1.2, miniaudio shared-mode engine)\n"
            "  --pipe <name>       named pipe (default: \\\\.\\pipe\\rhine-music.core.v1)\n"
            "  --trace <file>      append every emitted engine event to a file\n"
            "  --verbose           log every frame\n"
            "  --kill-after <sec>  simulate a crash after N seconds (exit code 7)\n"
            "  --no-preopen        start listening only after the first hello (debug)\n");
        return 0;
    }

    SetConsoleOutputCP(CP_UTF8);
    SetConsoleCtrlHandler(ConsoleHandler, TRUE);

    std::string pipe = ArgValue(argc, argv, "--pipe");
    if (pipe.empty()) {
        const std::wstring env = GetEnvWide(L"RHINE_CORE_PIPE");
        if (!env.empty()) pipe = WideToUtf8(env);
    }
    if (pipe.empty()) pipe = kDefaultPipe;
    pipe = PipeNameOnly(pipe);

    const std::string tracePath = ArgValue(argc, argv, "--trace");
    if (!tracePath.empty()) {
        if (g_trace.Open(tracePath)) {
            Log("info", "trace -> " + tracePath);
        } else {
            Log("error", "cannot open trace file: " + tracePath);
        }
    }
    const bool verbose = [argc, argv] {
        for (int i = 1; i < argc; ++i)
            if (std::strcmp(argv[i], "--verbose") == 0) return true;
        return false;
    }();

    HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    g_stopEvent.store(stopEvent, std::memory_order_release);

    // dev-only（--dev-inject）：stdin 监听，"underrun N" 注入 underrun 计数、"exit" 有序退出。
    // 验证 M4-b 升档接线的机器可测性；不带此标志时零行为改变（生产/冒烟默认不开）。
    const bool devInject = [argc, argv] {
        for (int i = 1; i < argc; ++i)
            if (std::strcmp(argv[i], "--dev-inject") == 0) return true;
        return false;
    }();

    const int killAfter = std::atoi(ArgValue(argc, argv, "--kill-after").c_str());
    if (killAfter > 0) {
        std::thread([killAfter] {
            std::this_thread::sleep_for(std::chrono::seconds(killAfter));
            Log("warn", "simulated crash after " + std::to_string(killAfter) + "s exit=7");
            ExitProcess(7);  // 桩同款：模拟崩溃（不经有序收尾）
        }).detach();
    }

    // 单实例互斥 = 管道首实例（任务书：第二实例连上收 bye{superseded} 的完整语义属 M4 域；
    // M2 首实例未退时第二实例 CreateNamedPipe 仍可能成功入队，但真实部署里壳只拉一份，
    // 与桩的同实例行为一致：桩也用 maxNumberOfServerInstances=1 + Create 失败退 3）。
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.bInheritHandle = FALSE;
    PSECURITY_DESCRIPTOR sd = nullptr;
    const std::wstring sddl = BuildPipeSddl();
    ConvertStringSecurityDescriptorToSecurityDescriptorW(
        sddl.c_str(), SDDL_REVISION_1, &sd, nullptr);
    if (sd) {
        sa.lpSecurityDescriptor = sd;
    } else {
        Log("warn", "pipe SACL build failed (err=" + std::to_string(GetLastError()) +
                        ") — fallback: inherit default descriptor");
    }

    std::atomic<std::int64_t> seq{0};
    std::atomic<std::int64_t> epoch{0};

    // 音频设备在进程启动即开（negotiated 的静态事实在首次 hello 补发的 state 里就位；
    // 任务书：设备句柄生命周期跨连接保留，桩同款）。
    rhine::AudioBackend audio;
    rhine::Engine engine(audio);  // 状态机进程级单例（桩同款：跨连接保留播放状态）
    {
        std::string error;
        if (!audio.OpenDevice(error)) {
            Log("error", "audio device open failed: " + error + " (running device-less)");
        } else {
            Log("info", "audio device ready: " + audio.device_facts().name + " rate=" +
                            std::to_string(audio.device_facts().appRate) + " ch=" +
                            std::to_string(audio.device_facts().appChannels) + " period=" +
                            std::to_string(audio.device_facts().periodFrames) + "x" +
                            std::to_string(audio.device_facts().periods));
        }
    }

    if (devInject) {
        std::thread([&audio] {
            std::string line;
            while (std::getline(std::cin, line)) {
                if (line == "exit" || line == "bye") {
                    g_shutdown.store(true, std::memory_order_release);
                    break;
                }
                if (line.rfind("underrun ", 0) == 0) {
                    const auto n = std::strtoull(line.c_str() + 9, nullptr, 10);
                    audio.InjectUnderruns(n);
                    Log("info", "dev-inject underrun +" + std::to_string(n));
                }
            }
        }).detach();
    }

    int exitCode = 0;
    int connections = 0;
    const std::wstring pipeWide = Utf8ToWide("\\\\.\\pipe\\" + pipe);
    HANDLE currentInstance = INVALID_HANDLE_VALUE;

    for (;;) {
        // 审查 P0-2：maxNumberOfServerInstances=1 —— 必须先断开+关闭上一实例再建新实例。
        // 原“预创建下一实例”标准模式在 max=1 下必吃 231（ALL_PIPE_INSTANCES_RESERVED），
        // 任何异常断线后进程直接 exit=5 死亡，破坏协议 §4/§9 的重连语义（桩同场景是退避续听）。
        if (currentInstance != INVALID_HANDLE_VALUE) {
            DisconnectNamedPipe(currentInstance);
            CloseHandle(currentInstance);
            currentInstance = INVALID_HANDLE_VALUE;
        }
        HANDLE next = INVALID_HANDLE_VALUE;
        for (int attempt = 0; attempt < 20 && next == INVALID_HANDLE_VALUE; ++attempt) {
            next = CreateNamedPipeW(pipeWide.c_str(),
                                    PIPE_ACCESS_DUPLEX | FILE_FLAG_WRITE_THROUGH,
                                    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT |
                                        PIPE_REJECT_REMOTE_CLIENTS,
                                    1, 64 * 1024, 64 * 1024, 0, sd ? &sa : nullptr);
            if (next == INVALID_HANDLE_VALUE) {
                const DWORD err = GetLastError();
                if (connections == 0) {
                    Log("error", "cannot create pipe (err=" + std::to_string(err) +
                                     ") — another core instance owns it? exit=3");
                    exitCode = 3;
                    break;
                }
                Log("warn", "create pipe retry err=" + std::to_string(err));
                Sleep(50);
            }
        }
        if (next == INVALID_HANDLE_VALUE) {
            if (exitCode == 0) exitCode = 5;
            break;
        }
        currentInstance = next;
        if (connections == 0) Log("info", "listening pipe=" + pipe);

        // 阻塞等待连接（ConnectNamedPipe + stop 事件二选一）。
        OVERLAPPED ov{};
        ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        BOOL connected = ConnectNamedPipe(currentInstance, &ov)
                             ? TRUE
                             : (GetLastError() == ERROR_PIPE_CONNECTED);
        if (!connected) {
            HANDLE waits[2] = {ov.hEvent, stopEvent};
            const DWORD wr = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
            if (wr == WAIT_OBJECT_0) {
                connected = TRUE;  // 连接完成事件置位
            } else {
                // 收到停止信号（或异常）：放弃本实例退出。
                CancelIoEx(currentInstance, &ov);
                CloseHandle(ov.hEvent);
                Log("info", "shutdown while listening");
                break;
            }
        }
        CloseHandle(ov.hEvent);
        if (!connected) {
            Log("warn", "connect failed (err=" + std::to_string(GetLastError()) + ")");
            continue;
        }

        FlushFileBuffers(currentInstance);
        connections++;
        Log("info", "client connected conn=" + std::to_string(connections));

        Session session(currentInstance, audio, engine, seq, epoch);
        session.SetVerbose(verbose);
        bool orderly = false;
        try {
            orderly = session.Run();
        } catch (const std::exception& ex) {
            Log("error", std::string("session fault → exit 5: ") + ex.what());
            exitCode = 5;
        } catch (...) {
            Log("error", "session fault (unknown exception) → exit 5");
            exitCode = 5;
        }
        DisconnectNamedPipe(currentInstance);
        if (exitCode == 5) break;
        if (orderly) {
            Log("info", "orderly shutdown exit=0");
            break;
        }
        if (g_shutdown.load(std::memory_order_relaxed)) break;
        Log("info", "session ended");
    }

    audio.CloseDevice();
    g_trace.WriteLine("");  // 收尾空行无害；主要保证缓冲区随进程关闭落盘
    if (stopEvent) CloseHandle(stopEvent);
    if (currentInstance != INVALID_HANDLE_VALUE) CloseHandle(currentInstance);
    if (sd) LocalFree(sd);
    if (exitCode == 0) Log("info", "stopped");
    return exitCode;
}
