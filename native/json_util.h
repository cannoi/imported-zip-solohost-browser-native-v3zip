#pragma once
#include <string>
#include <unordered_map>

namespace jsonutil {
std::unordered_map<std::string,std::string> parseObject(const std::string& s);
std::string escape(const std::string& s);
std::string quote(const std::string& s);
}
