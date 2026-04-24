#pragma once
#include "uint256.h"
#include <vector>

class CBlockHeader {
public:
    uint256 hashPrevBlock;
    uint256 hashMerkleRoot;
    uint256 hashFinalSaplingRoot;
    uint32_t nVersion;
    uint32_t nTime;
    uint32_t nBits;
    uint256 nNonce;
    std::vector<unsigned char> nSolution;
};
