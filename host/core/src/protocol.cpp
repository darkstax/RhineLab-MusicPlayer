// protocol.cpp — 见 protocol.h 的契约说明。
#include "protocol.h"

#include <chrono>

namespace rhine::proto {

std::optional<Json> ParseLine(std::string_view line) {
    // 不允许抛：parse 用 allow_exceptions=false，畸形输入返回 discarded。
    Json parsed = Json::parse(line.begin(), line.end(), nullptr, /*allow_exceptions=*/false);
    if (parsed.is_discarded() || !parsed.is_object()) return std::nullopt;
    return parsed;
}

std::string Dump(const Json& frame) {
    // ensure_ascii=false：UTF-8 原样输出（协议 §1 的编码约定）。
    return frame.dump(/*indent=*/-1, /*indent_char=*/' ', /*ensure_ascii=*/false);
}

namespace {
const Json* Find(const Json& obj, std::string_view key) {
    if (!obj.is_object()) return nullptr;
    auto it = obj.find(std::string(key));
    return it == obj.end() ? nullptr : &(*it);
}
}  // namespace

std::optional<std::string> SafeString(const Json& obj, std::string_view key) {
    const Json* v = Find(obj, key);
    if (v == nullptr || !v->is_string()) return std::nullopt;
    return v->get<std::string>();
}

std::optional<double> SafeDouble(const Json& obj, std::string_view key) {
    const Json* v = Find(obj, key);
    if (v == nullptr || !v->is_number()) return std::nullopt;
    return v->get<double>();
}

std::optional<std::int64_t> SafeInt64(const Json& obj, std::string_view key) {
    const Json* v = Find(obj, key);
    if (v == nullptr || !v->is_number()) return std::nullopt;
    // 与桩的 (long)position.Value 同语义：向零截断，不四舍五入。
    return static_cast<std::int64_t>(v->get<double>());
}

std::optional<bool> SafeBool(const Json& obj, std::string_view key) {
    const Json* v = Find(obj, key);
    if (v == nullptr || !v->is_boolean()) return std::nullopt;
    return v->get<bool>();
}

std::vector<std::string> SafeStringArray(const Json& obj, std::string_view key) {
    std::vector<std::string> out;
    const Json* v = Find(obj, key);
    if (v == nullptr || !v->is_array()) return out;
    for (const Json& item : *v) {
        if (item.is_string()) out.push_back(item.get<std::string>());
    }
    return out;
}

std::int64_t NowMs() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count();
}

std::optional<std::string> FrameType(const Json& frame) { return SafeString(frame, "t"); }

std::optional<std::string> FrameId(const Json& frame) { return SafeString(frame, "id"); }

Json MakeAck(const std::optional<std::string>& id, Json result) {
    Json frame{{"v", 1}, {"t", "ack"}};
    if (id.has_value()) frame["id"] = *id;
    frame["result"] = result.is_null() ? Json(nullptr) : std::move(result);
    return frame;
}

Json MakeErr(const std::optional<std::string>& id, std::string_view code, std::string_view message,
             bool retryable) {
    Json frame{{"v", 1}, {"t", "err"}};
    frame["error"] = Json{{"code", std::string(code)},
                          {"message", std::string(message)},
                          {"retryable", retryable}};
    if (id.has_value()) frame["id"] = *id;
    return frame;
}

Json MakeEvt(std::int64_t seq, std::int64_t ep, std::string_view kind, Json data) {
    return Json{{"v", 1},
                {"t", "evt"},
                {"seq", seq},
                {"ep", ep},
                {"evt", std::string(kind)},
                {"data", std::move(data)},
                {"ts", NowMs()}};
}

Json MakeHelloCore(std::int64_t ep, const Json& caps) {
    return Json{{"v", 1},
                {"t", "hello"},
                {"role", "core"},
                {"proto", 1},
                {"ep", ep},
                {"caps", caps},
                {"app", "rhine-music-player"},
                {"ver", "0.1.0"}};
}

Json MakeBye(std::string_view reason) {
    return Json{{"v", 1}, {"t", "bye"}, {"reason", std::string(reason)}};
}

}  // namespace rhine::proto
