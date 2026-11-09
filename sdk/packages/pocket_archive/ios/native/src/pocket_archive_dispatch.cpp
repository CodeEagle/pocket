#include "pocket_archive_native.h"

#include <algorithm>
#include <array>
#include <fstream>
#include <iterator>
#include <string>
#include <filesystem>

namespace {

void SetError(char *buffer, size_t bufferSize, const char *message) {
  if (buffer == nullptr || bufferSize == 0) return;
  const std::string value = message == nullptr ? "native-error" : message;
  const size_t count = value.size() < bufferSize - 1 ? value.size() : bufferSize - 1;
  std::copy(value.begin(), value.begin() + count, buffer);
  buffer[count] = '\0';
}

bool Is7z(const std::array<unsigned char, 6>& head) {
  static constexpr unsigned char signature[] = {0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c};
  return std::equal(std::begin(signature), std::end(signature), head.begin());
}

bool IsZip(const std::array<unsigned char, 6>& head) {
  return head[0] == 'P' && head[1] == 'K'
      && ((head[2] == 3 && head[3] == 4)
          || (head[2] == 5 && head[3] == 6)
          || (head[2] == 7 && head[3] == 8));
}

} // namespace

extern "C" int32_t pocket_archive_extract(
    const char *archivePath,
    const char *stagingPath,
    const char *password,
    uint64_t maxOutputBytes,
    char *errorBuffer,
    size_t errorBufferSize) {
  SetError(errorBuffer, errorBufferSize, "");
  if (archivePath == nullptr || stagingPath == nullptr || archivePath[0] == '\0'
      || stagingPath[0] == '\0' || maxOutputBytes == 0) {
    SetError(errorBuffer, errorBufferSize, "invalid-arguments");
    return 1;
  }

  try {
    std::ifstream input(std::filesystem::u8path(archivePath), std::ios::binary);
    std::array<unsigned char, 6> head{};
    input.read(reinterpret_cast<char *>(head.data()), head.size());
    const std::streamsize count = input.gcount();
    input.close();
    if (count >= 6 && Is7z(head)) {
      if (password != nullptr && password[0] != '\0') {
        SetError(errorBuffer, errorBufferSize, "unsupported-7z-encryption");
        return 2;
      }
      return pocket_archive_extract_7z(archivePath, stagingPath,
          maxOutputBytes, errorBuffer, errorBufferSize);
    }
    if (count >= 4 && IsZip(head)) {
      return pocket_archive_extract_zip(archivePath, stagingPath, password,
          maxOutputBytes, errorBuffer, errorBufferSize);
    }
    SetError(errorBuffer, errorBufferSize, "unsupported-archive");
    return 3;
  } catch (...) {
    SetError(errorBuffer, errorBufferSize, "native-exception");
    return 4;
  }
}
