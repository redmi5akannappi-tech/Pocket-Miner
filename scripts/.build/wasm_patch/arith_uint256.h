#pragma once
#include "uint256.h"

class arith_uint256 : public uint256 {
public:
    arith_uint256() : uint256() {}
    explicit arith_uint256(const uint256& a) : uint256(a) {}
    bool operator>(const arith_uint256& o) const { return memcmp(data, o.data, 32) > 0; }
};

inline arith_uint256 UintToArith256(const uint256& a) {
    return arith_uint256(a);
}
