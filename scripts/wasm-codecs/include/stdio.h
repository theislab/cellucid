/* <stdio.h> for the freestanding WebAssembly build: the decoders never
   print; messages they would write (compression and threading paths, which
   this build never runs) are dropped. */
#ifndef CELLUCID_WASM_STDIO_H
#define CELLUCID_WASM_STDIO_H
#include <stddef.h>
#include <stdarg.h>
typedef struct cellucid_wasm_file FILE;
#define stderr ((FILE *)0)
#define stdout ((FILE *)0)
#define printf(...) ((int)0)
#define fprintf(...) ((int)0)
#define sprintf(...) ((int)0)
#define snprintf(...) ((int)0)
#define fflush(file) ((int)0)
#define EOF (-1)
#endif
