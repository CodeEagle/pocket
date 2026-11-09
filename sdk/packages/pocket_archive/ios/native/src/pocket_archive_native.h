#ifndef POCKET_ARCHIVE_NATIVE_H_
#define POCKET_ARCHIVE_NATIVE_H_

#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define POCKET_ARCHIVE_EXPORT __declspec(dllexport)
#else
#define POCKET_ARCHIVE_EXPORT __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

POCKET_ARCHIVE_EXPORT int32_t pocket_archive_extract(
    const char *archive_path,
    const char *staging_path,
    const char *password,
    uint64_t max_output_bytes,
    char *error_buffer,
    size_t error_buffer_size);

int32_t pocket_archive_extract_zip(
    const char *archive_path,
    const char *staging_path,
    const char *password,
    uint64_t max_output_bytes,
    char *error_buffer,
    size_t error_buffer_size);

int32_t pocket_archive_extract_7z(
    const char *archive_path,
    const char *staging_path,
    uint64_t max_output_bytes,
    char *error_buffer,
    size_t error_buffer_size);

#ifdef __cplusplus
}
#endif

#endif
