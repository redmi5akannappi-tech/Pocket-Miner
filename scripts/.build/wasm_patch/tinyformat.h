#pragma once
#include <string>
namespace tfm {
    template<typename... Args>
    std::string format(const std::string &fmt, Args... args) { return fmt; }
}
template<typename... Args>
std::string strprintf(const std::string &fmt, Args... args) { return tfm::format(fmt, args...); }
