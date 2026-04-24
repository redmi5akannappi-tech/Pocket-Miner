#pragma once
#include <stdint.h>
#include <string.h>
#include <string>

class uint256 {
public:
    uint8_t data[32];
    uint256() { memset(data, 0, 32); }
    uint256(const uint256& o) { memcpy(data, o.data, 32); }
    uint256& operator=(const uint256& o) { memcpy(data, o.data, 32); return *this; }
    bool operator==(const uint256& o) const { return memcmp(data, o.data, 32) == 0; }
    bool operator!=(const uint256& o) const { return !(*this == o); }
    bool operator<(const uint256& o) const { return memcmp(data, o.data, 32) < 0; }
    std::string GetHex() const { return std::string(64, '0'); }
    void SetHex(const char*) {}
};

inline uint256 uint256S(const char*) { return uint256(); }
