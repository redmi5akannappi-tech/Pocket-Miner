#pragma once
#define __cpuid(leaf,a,b,c,d)      do{(a)=(b)=(c)=(d)=0;}while(0)
#define __cpuid_count(l,s,a,b,c,d) do{(a)=(b)=(c)=(d)=0;}while(0)
#define __get_cpuid_max(l,s)       0
#define __get_cpuid(l,a,b,c,d)     0
#define bit_AVX    0
#define bit_AES    0
#define bit_PCLMUL 0
#define bit_SSE2   0
#define bit_SSE4_1 0
#define bit_AVX2   0
