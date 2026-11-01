/* <unistd.h> for the freestanding WebAssembly build: no POSIX services
   (so c-blosc allocates with malloc, not posix_memalign). */
#ifndef CELLUCID_WASM_UNISTD_H
#define CELLUCID_WASM_UNISTD_H
#include <sys/types.h>
#endif
