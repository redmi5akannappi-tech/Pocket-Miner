#pragma once
#include "uint256.h"
#include "arith_uint256.h"
#include "verus_clhash.h"
#include "verus_hash.h"

class CVerusHashV2Writer {
private:
    CVerusHashV2 state;
public:
    int nType;
    int nVersion;
    CVerusHashV2Writer(int nTypeIn, int nVersionIn) : nType(nTypeIn), nVersion(nVersionIn), state() {}
    void Reset() { state.Reset(); }
    CVerusHashV2Writer& write(const char *pch, size_t size) {
        state.Write((const unsigned char*)pch, size);
        return (*this);
    }
    uint256 GetHash() {
        uint256 result;
        state.Finalize((unsigned char*)&result);
        return result;
    }
    int64_t *xI64p() { return state.ExtraI64Ptr(); }
    CVerusHashV2 &GetState() { return state; }
    template<typename T> CVerusHashV2Writer& operator<<(const T& obj) { return (*this); }
};

class CVerusHashV2bWriter {
private:
    CVerusHashV2 state;
public:
    int nType;
    int nVersion;
    CVerusHashV2bWriter(int nTypeIn, int nVersionIn, int solutionVersion=SOLUTION_VERUSHHASH_V2, uint64_t keysize=VERUSKEYSIZE) : 
        nType(nTypeIn), nVersion(nVersionIn), state(solutionVersion) {}
    void Reset() { state.Reset(); }
    CVerusHashV2bWriter& write(const char *pch, size_t size) {
        state.Write((const unsigned char*)pch, size);
        return (*this);
    }
    uint256 GetHash() {
        uint256 result;
        state.Finalize2b((unsigned char*)&result);
        return result;
    }
    inline int64_t *xI64p() { return state.ExtraI64Ptr(); }
    CVerusHashV2 &GetState() { return state; }
    template<typename T> CVerusHashV2bWriter& operator<<(const T& obj) { return (*this); }
};
