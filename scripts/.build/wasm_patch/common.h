#pragma once
#include <stdint.h>
#include <string.h>
#include <string>

static inline uint16_t ReadLE16(const uint8_t* p){
    uint16_t v; memcpy(&v,p,2); return v; }
static inline uint32_t ReadLE32(const uint8_t* p){
    uint32_t v; memcpy(&v,p,4); return v; }
static inline uint64_t ReadLE64(const uint8_t* p){
    uint64_t v; memcpy(&v,p,8); return v; }
static inline void WriteLE16(uint8_t* p, uint16_t v){ memcpy(p,&v,2); }
static inline void WriteLE32(uint8_t* p, uint32_t v){ memcpy(p,&v,4); }
static inline void WriteLE64(uint8_t* p, uint64_t v){ memcpy(p,&v,8); }
static inline uint32_t ReadBE32(const uint8_t* p){
    uint32_t v; memcpy(&v,p,4);
    return ((v&0xFF)<<24)|((v>>8&0xFF)<<16)|((v>>16&0xFF)<<8)|(v>>24); }
static inline void WriteBE32(uint8_t* p, uint32_t v){
    uint32_t b=((v&0xFF)<<24)|((v>>8&0xFF)<<16)|((v>>16&0xFF)<<8)|(v>>24);
    memcpy(p,&b,4); }
static inline uint32_t ReadBE16(const uint8_t* p){
    uint16_t v; memcpy(&v,p,2); return ((v&0xFF)<<8)|(v>>8); }
