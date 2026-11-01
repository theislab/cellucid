/* The part of <string.h> the decoders use, for a freestanding WebAssembly
   build (scripts/build-wasm-codecs.mjs): copies and fills are the
   bulk-memory instructions; the rest is in libc.c. */
#ifndef CELLUCID_WASM_STRING_H
#define CELLUCID_WASM_STRING_H
#include <stddef.h>
void *memcpy(void *destination, const void *source, size_t length);
void *memmove(void *destination, const void *source, size_t length);
void *memset(void *destination, int value, size_t length);
int memcmp(const void *a, const void *b, size_t length);
size_t strlen(const char *text);
int strcmp(const char *a, const char *b);
int strncmp(const char *a, const char *b, size_t length);
char *strcpy(char *destination, const char *source);
char *strncpy(char *destination, const char *source, size_t length);
char *strcat(char *destination, const char *source);
char *strdup(const char *text);
#define strerror(code) ((char *)"")
#define memcpy(d, s, n) __builtin_memcpy((d), (s), (n))
#define memmove(d, s, n) __builtin_memmove((d), (s), (n))
#define memset(d, v, n) __builtin_memset((d), (v), (n))
#endif
