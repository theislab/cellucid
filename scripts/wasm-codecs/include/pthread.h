/* <pthread.h> for the freestanding WebAssembly build. c-blosc decodes with
   one thread here (blosc_decompress_ctx(..., 1)): it never starts a thread
   or waits on one, so these are inert. A thread that would be started
   fails to start (EAGAIN). */
#ifndef CELLUCID_WASM_PTHREAD_H
#define CELLUCID_WASM_PTHREAD_H
#include <errno.h>
typedef int pthread_t;
typedef int pthread_attr_t;
typedef int pthread_mutex_t;
typedef int pthread_mutexattr_t;
typedef int pthread_cond_t;
typedef int pthread_condattr_t;
typedef int pthread_once_t;
#define PTHREAD_ONCE_INIT 0
#define PTHREAD_CREATE_JOINABLE 0
static inline int pthread_create(pthread_t *thread, const pthread_attr_t *attr, void *(*run)(void *), void *argument) {
  (void)thread; (void)attr; (void)run; (void)argument; return EAGAIN;
}
static inline int pthread_join(pthread_t thread, void **result) { (void)thread; (void)result; return EINVAL; }
static inline int pthread_attr_init(pthread_attr_t *attr) { (void)attr; return 0; }
static inline int pthread_attr_destroy(pthread_attr_t *attr) { (void)attr; return 0; }
static inline int pthread_attr_setdetachstate(pthread_attr_t *attr, int state) { (void)attr; (void)state; return 0; }
static inline int pthread_mutex_init(pthread_mutex_t *mutex, const pthread_mutexattr_t *attr) { (void)mutex; (void)attr; return 0; }
static inline int pthread_mutex_destroy(pthread_mutex_t *mutex) { (void)mutex; return 0; }
static inline int pthread_mutex_lock(pthread_mutex_t *mutex) { (void)mutex; return 0; }
static inline int pthread_mutex_unlock(pthread_mutex_t *mutex) { (void)mutex; return 0; }
static inline int pthread_cond_init(pthread_cond_t *cond, const pthread_condattr_t *attr) { (void)cond; (void)attr; return 0; }
static inline int pthread_cond_destroy(pthread_cond_t *cond) { (void)cond; return 0; }
static inline int pthread_cond_wait(pthread_cond_t *cond, pthread_mutex_t *mutex) { (void)cond; (void)mutex; return 0; }
static inline int pthread_cond_broadcast(pthread_cond_t *cond) { (void)cond; return 0; }
static inline pthread_t pthread_self(void) { return 0; }
static inline int pthread_once(pthread_once_t *once, void (*run)(void)) {
  if (*once == 0) {
    *once = 1;
    run();
  }
  return 0;
}
static inline int pthread_atfork(void (*prepare)(void), void (*parent)(void), void (*child)(void)) {
  (void)prepare; (void)parent; (void)child; return 0;
}
#endif
