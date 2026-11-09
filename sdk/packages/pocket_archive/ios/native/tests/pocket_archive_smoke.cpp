#include "pocket_archive_native.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>

int main(int argc, char **argv) {
  if (argc < 4 || argc > 5) {
    std::fprintf(stderr,
        "usage: %s ARCHIVE EMPTY_STAGE MAX_OUTPUT_BYTES [PASSWORD]\n", argv[0]);
    return 2;
  }
  char *end = nullptr;
  const unsigned long long limit = std::strtoull(argv[3], &end, 10);
  if (end == argv[3] || *end != '\0' || limit == 0) {
    std::fprintf(stderr, "max output must be a positive integer\n");
    return 2;
  }
  char error[128] = {};
  const int32_t result = pocket_archive_extract(argv[1], argv[2],
      argc == 5 ? argv[4] : nullptr, static_cast<uint64_t>(limit),
      error, sizeof(error));
  std::printf("result=%d error=%s\n", result,
      std::strlen(error) == 0 ? "none" : error);
  return result == 0 ? 0 : 1;
}
