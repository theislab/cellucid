/* The part of <stdlib.h> the decoders use (freestanding WebAssembly build):
   the allocator is libc.c's; nothing reads an environment. */
#ifndef CELLUCID_WASM_STDLIB_H
#define CELLUCID_WASM_STDLIB_H
#include <stddef.h>
void *malloc(size_t size);
void *calloc(size_t count, size_t size);
void *realloc(void *block, size_t size);
void free(void *block);
int posix_memalign(void **block, size_t alignment, size_t size);
#define getenv(name) ((char *)0)
#define abort() __builtin_trap()
#define exit(code) __builtin_trap()
int abs(int value);
long labs(long value);
int atoi(const char *text);
long strtol(const char *text, char **end, int base);
#endif
