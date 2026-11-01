/*
 * The C library the decoders of assets/wasm/codecs.wasm link against, for a
 * freestanding WebAssembly build (scripts/build-wasm-codecs.mjs): memory, and
 * the few string functions their sources name.
 *
 * Memory is one arena over the module's linear memory, from __heap_base up:
 *
 * - what the module keeps between calls (none of the decoders keeps
 *   anything today) lies below `kept`;
 * - each call's buffers (`codecs_buffers`, codecs.c) start at `kept`, and
 *   what a decoder allocates while it decodes lies above them, released when
 *   the call returns (`heap_mark` / `heap_release`).
 *
 * `free` of the latest block gives it back at once (zlib and c-blosc free
 * what they allocated in reverse order); any other `free` waits for the
 * release at the end of the call. The memory grows as a call needs it
 * (memory.grow) and a failed growth is a null pointer, which every decoder
 * reports as an allocation failure.
 */

#include <stddef.h>
#include <stdint.h>

#undef memcpy
#undef memmove
#undef memset

extern unsigned char __heap_base;

#define ALIGNMENT 16u
#define PAGE_BYTES 65536u

static uintptr_t top = 0;
static uintptr_t latest = 0;

static uintptr_t align_up(uintptr_t value, uintptr_t alignment) {
  return (value + alignment - 1) & ~(alignment - 1);
}

static uintptr_t heap_start(void) {
  return align_up((uintptr_t)&__heap_base, ALIGNMENT);
}

/* Grow the memory to hold [0, end): 0 when it cannot. */
static int hold(uintptr_t end) {
  uintptr_t held = (uintptr_t)__builtin_wasm_memory_size(0) * PAGE_BYTES;
  if (end <= held) return 1;
  uintptr_t pages = (end - held + PAGE_BYTES - 1) / PAGE_BYTES;
  return __builtin_wasm_memory_grow(0, pages) != (size_t)-1;
}

static void *allocate(size_t size, size_t alignment) {
  if (top == 0) top = heap_start();
  uintptr_t start = align_up(top, alignment < ALIGNMENT ? ALIGNMENT : alignment);
  if (start < top || size > UINTPTR_MAX - start - ALIGNMENT) return NULL;
  uintptr_t end = align_up(start + (size == 0 ? 1 : size), ALIGNMENT);
  if (!hold(end)) return NULL;
  latest = start;
  top = end;
  return (void *)start;
}

void *malloc(size_t size) { return allocate(size, ALIGNMENT); }

void *calloc(size_t count, size_t size) {
  if (size != 0 && count > SIZE_MAX / size) return NULL;
  void *block = allocate(count * size, ALIGNMENT);
  if (block != NULL) __builtin_memset(block, 0, count * size);
  return block;
}

int posix_memalign(void **block, size_t alignment, size_t size) {
  *block = allocate(size, alignment);
  return *block == NULL ? 12 : 0;
}

void free(void *block) {
  if (block != NULL && (uintptr_t)block == latest) {
    top = latest;
    latest = 0;
  }
}

void *realloc(void *block, size_t size) {
  if (block == NULL) return malloc(size);
  if ((uintptr_t)block == latest) {
    uintptr_t end = align_up((uintptr_t)block + (size == 0 ? 1 : size), ALIGNMENT);
    if (!hold(end)) return NULL;
    top = end;
    return block;
  }
  /* An older block's size is not kept: decoders never resize one. */
  return NULL;
}

/* The arena's top: everything allocated after it goes with heap_release. */
uintptr_t heap_mark(void) {
  if (top == 0) top = heap_start();
  return top;
}

void heap_release(uintptr_t mark) {
  top = mark;
  latest = 0;
}

/* Copies and fills: the bulk-memory instructions (memory.copy, memory.fill). */
void *memcpy(void *destination, const void *source, size_t length) {
  return __builtin_memcpy(destination, source, length);
}

void *memmove(void *destination, const void *source, size_t length) {
  return __builtin_memmove(destination, source, length);
}

void *memset(void *destination, int value, size_t length) {
  return __builtin_memset(destination, value, length);
}

int memcmp(const void *a, const void *b, size_t length) {
  const unsigned char *x = a;
  const unsigned char *y = b;
  for (size_t i = 0; i < length; i++) {
    if (x[i] != y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

size_t strlen(const char *text) {
  size_t length = 0;
  while (text[length] != '\0') length++;
  return length;
}

int strcmp(const char *a, const char *b) {
  while (*a != '\0' && *a == *b) {
    a++;
    b++;
  }
  return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t length) {
  for (size_t i = 0; i < length; i++) {
    if (a[i] != b[i] || a[i] == '\0') return (unsigned char)a[i] - (unsigned char)b[i];
  }
  return 0;
}

char *strcpy(char *destination, const char *source) {
  char *at = destination;
  while ((*at++ = *source++) != '\0') {}
  return destination;
}

char *strncpy(char *destination, const char *source, size_t length) {
  size_t i = 0;
  for (; i < length && source[i] != '\0'; i++) destination[i] = source[i];
  for (; i < length; i++) destination[i] = '\0';
  return destination;
}

char *strcat(char *destination, const char *source) {
  strcpy(destination + strlen(destination), source);
  return destination;
}

char *strdup(const char *text) {
  size_t length = strlen(text) + 1;
  char *copy = malloc(length);
  if (copy != NULL) __builtin_memcpy(copy, text, length);
  return copy;
}

int abs(int value) { return value < 0 ? -value : value; }

long labs(long value) { return value < 0 ? -value : value; }
