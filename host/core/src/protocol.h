// protocol.h — JSON Lines 帧的编解码与 SafeX 取值族（docs/IPC-PROTOCOL.md v1.2）。
// 纪律（协议 §10）：对端帧字段类型越界一律**不抛异常**，降级为缺省/null；
// 本模块只负责帧的形状，命令语义在 engine。
#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "json.hpp"

namespace rhine::proto {

using Json = nlohmann::json;

// 解析一行 JSON；非法 JSON / 非对象 → nullopt（调用方按 §10 回 bad_request 并丢弃）。
std::optional<Json> ParseLine(std::string_view line);

// 序列化为一帧（不带换行；调用方追加 '\n'）。禁止抛：Dump 对已解析树不会失败。
std::string Dump(const Json& frame);

// —— SafeX 族：键不存在 / 类型不符 → nullopt，绝不抛（对应桩的 SafeString/Num）——
std::optional<std::string> SafeString(const Json& obj, std::string_view key);
std::optional<double> SafeDouble(const Json& obj, std::string_view key);
std::optional<std::int64_t> SafeInt64(const Json& obj, std::string_view key);
std::optional<bool> SafeBool(const Json& obj, std::string_view key);
// 字符串数组（如 hello.caps）：非数组返回空；数组内非字符串元素按 §10 跳过。
std::vector<std::string> SafeStringArray(const Json& obj, std::string_view key);

// 帧的公共字段便捷读取。
std::optional<std::string> FrameType(const Json& frame);   // t
std::optional<std::string> FrameId(const Json& frame);     // id

std::int64_t NowMs();  // epoch ms（ts 字段用）

// —— 出站帧构造器（字段严格按 §2/§3/§4/§5/§6，不自加）——
Json MakeAck(const std::optional<std::string>& id, Json result);
Json MakeErr(const std::optional<std::string>& id, std::string_view code, std::string_view message,
             bool retryable);
Json MakeEvt(std::int64_t seq, std::int64_t ep, std::string_view kind, Json data);
Json MakeHelloCore(std::int64_t ep, const Json& caps);
Json MakeBye(std::string_view reason);

}  // namespace rhine::proto
