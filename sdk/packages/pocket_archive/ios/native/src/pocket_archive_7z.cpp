#include "pocket_archive_native.h"

#include "7zip/C/7z.h"
#include "7zip/C/7zCrc.h"
#include "7zip/C/7zFile.h"
#include "7zip/C/7zTypes.h"

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <filesystem>
#include <limits>
#include <map>
#include <mutex>
#include <set>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#endif

namespace {

namespace fs = std::filesystem;
constexpr size_t kMaxEntries = 100000;
constexpr size_t kMaxPathChars = 4096;
constexpr size_t kInputBufferSize = 1u << 18;
constexpr size_t kHeaderMainAllocationLimit = 64u * 1024u * 1024u;
constexpr size_t kHeaderTempAllocationLimit = 64u * 1024u * 1024u;
constexpr size_t kNativeAllocationSlack = 128u * 1024u * 1024u;

void SetError(char *buffer, size_t bufferSize, const char *message) {
  if (buffer == nullptr || bufferSize == 0) return;
  const char *value = message == nullptr ? "native-error" : message;
  std::strncpy(buffer, value, bufferSize - 1);
  buffer[bufferSize - 1] = '\0';
}

std::once_flag g_CrcTableInit;

struct alignas(std::max_align_t) CAllocationHeader {
  size_t allocationSize;
};

struct CBoundedAllocator {
  ISzAlloc vtable{};
  size_t allocated = 0;
  size_t limit = 0;

  explicit CBoundedAllocator(size_t allocationLimit) : limit(allocationLimit) {
    vtable.Alloc = Allocate;
    vtable.Free = Free;
  }

  static CBoundedAllocator *State(ISzAllocPtr allocator) {
    return const_cast<CBoundedAllocator *>(
        reinterpret_cast<const CBoundedAllocator *>(allocator));
  }

  static void *Allocate(ISzAllocPtr allocator, size_t size) {
    if (size == 0 || size > std::numeric_limits<size_t>::max() - sizeof(CAllocationHeader))
      return nullptr;
    CBoundedAllocator *state = State(allocator);
    const size_t totalSize = sizeof(CAllocationHeader) + size;
    if (state->allocated > state->limit || totalSize > state->limit - state->allocated)
      return nullptr;
    auto *header = static_cast<CAllocationHeader *>(std::malloc(totalSize));
    if (header == nullptr) return nullptr;
    header->allocationSize = totalSize;
    state->allocated += totalSize;
    return header + 1;
  }

  static void Free(ISzAllocPtr allocator, void *address) {
    if (address == nullptr) return;
    CBoundedAllocator *state = State(allocator);
    auto *header = static_cast<CAllocationHeader *>(address) - 1;
    if (header->allocationSize <= state->allocated)
      state->allocated -= header->allocationSize;
    else
      state->allocated = 0;
    std::free(header);
  }

  void SetLimit(size_t allocationLimit) {
    limit = std::max(allocationLimit, allocated);
  }
};

size_t AllocationLimitWithSlack(UInt64 requested, size_t slack) {
  const size_t maxSize = std::numeric_limits<size_t>::max();
  if (requested >= maxSize) return maxSize;
  const size_t outputLimit = static_cast<size_t>(requested);
  return outputLimit > maxSize - slack ? maxSize : outputLimit + slack;
}

struct CDatabaseGuard {
  CSzArEx *database;
  ISzAllocPtr allocator;
  ~CDatabaseGuard() { SzArEx_Free(database, allocator); }
};

struct COutputBufferCache {
  ISzAllocPtr allocator;
  Byte *bytes = nullptr;
  size_t size = 0;
  explicit COutputBufferCache(ISzAllocPtr value) : allocator(value) {}
  ~COutputBufferCache() { ISzAlloc_Free(allocator, bytes); }
};

struct CNativeFileStream {
  CFileInStream stream{};

  bool Open(const char *path) {
    File_Construct(&stream.file);
    FileInStream_CreateVTable(&stream);
    stream.wres = 0;
    return InFile_Open(&stream.file, path) == 0;
  }

  ~CNativeFileStream() {
    File_Close(&stream.file);
  }
};

struct CEntry {
  std::string path;
  std::string folded;
  bool directory = false;
  UInt64 size = 0;
};

bool Utf16ToUtf8(const UInt16 *input, size_t length, std::string &output) {
  output.clear();
  for (size_t i = 0; i < length; ++i) {
    uint32_t codepoint = input[i];
    if (codepoint == 0) return false;
    if (codepoint >= 0xD800 && codepoint <= 0xDBFF) {
      if (i + 1 >= length) return false;
      const uint32_t low = input[++i];
      if (low < 0xDC00 || low > 0xDFFF) return false;
      codepoint = 0x10000 + ((codepoint - 0xD800) << 10) + (low - 0xDC00);
    } else if (codepoint >= 0xDC00 && codepoint <= 0xDFFF) {
      return false;
    }
    if (codepoint <= 0x7F) {
      output.push_back(static_cast<char>(codepoint));
    } else if (codepoint <= 0x7FF) {
      output.push_back(static_cast<char>(0xC0 | (codepoint >> 6)));
      output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    } else if (codepoint <= 0xFFFF) {
      output.push_back(static_cast<char>(0xE0 | (codepoint >> 12)));
      output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
      output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    } else {
      output.push_back(static_cast<char>(0xF0 | (codepoint >> 18)));
      output.push_back(static_cast<char>(0x80 | ((codepoint >> 12) & 0x3F)));
      output.push_back(static_cast<char>(0x80 | ((codepoint >> 6) & 0x3F)));
      output.push_back(static_cast<char>(0x80 | (codepoint & 0x3F)));
    }
  }
  return !output.empty();
}

bool IsSafeRelativePath(const std::string &path) {
  if (path.empty() || path.size() > kMaxPathChars || path[0] == '/' || path[0] == '\\')
    return false;
  if (path.find('\\') != std::string::npos || path.find('\0') != std::string::npos)
    return false;
  if (path.find(':') != std::string::npos)
    return false;
  size_t start = 0;
  for (size_t i = 0; i <= path.size(); ++i) {
    if (i != path.size() && path[i] != '/') continue;
    const size_t length = i - start;
    if (length == 0 || (length == 1 && path[start] == '.')
        || (length == 2 && path[start] == '.' && path[start + 1] == '.'))
      return false;
    start = i + 1;
  }
  return true;
}

std::string FoldPathAscii(const std::string &path) {
  std::string folded(path);
  for (char &c : folded) {
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c + ('a' - 'A'));
  }
  return folded;
}

bool ValidateEntryTree(const std::vector<CEntry> &entries) {
  std::set<std::string> exact;
  std::set<std::string> folded;
  std::map<std::string, bool> isDirectory;
  for (const CEntry &entry : entries) {
    if (!IsSafeRelativePath(entry.path)) return false;
    if (!exact.insert(entry.path).second || !folded.insert(entry.folded).second) return false;
    isDirectory.emplace(entry.folded, entry.directory);
  }
  for (const CEntry &entry : entries) {
    size_t slash = entry.folded.find('/');
    while (slash != std::string::npos) {
      const auto parent = isDirectory.find(entry.folded.substr(0, slash));
      if (parent != isDirectory.end() && !parent->second) return false;
      slash = entry.folded.find('/', slash + 1);
    }
  }
  return true;
}

bool IsEmptyDirectory(const fs::path &path) {
  std::error_code error;
  const fs::file_status status = fs::symlink_status(path, error);
  if (error || fs::is_symlink(status) || !fs::is_directory(status)) return false;
  fs::directory_iterator current(path, error), end;
  return !error && current == end;
}

bool EnsureDirectories(const fs::path &root, const std::string &relative) {
  size_t slash = relative.find('/');
  while (slash != std::string::npos) {
    const fs::path part = fs::u8path(relative.substr(0, slash));
    const fs::path path = root / part;
    std::error_code error;
    const fs::file_status status = fs::symlink_status(path, error);
    if (!error) {
      if (fs::is_symlink(status) || !fs::is_directory(status)) return false;
    } else if (error == std::errc::no_such_file_or_directory) {
      error.clear();
      if (!fs::create_directory(path, error) && error) return false;
      const fs::file_status created = fs::symlink_status(path, error);
      if (error || fs::is_symlink(created) || !fs::is_directory(created)) return false;
    } else {
      return false;
    }
    slash = relative.find('/', slash + 1);
  }
  return true;
}

class COutputFile {
 public:
  bool Open(const fs::path &path) {
#if defined(_WIN32)
    _handle = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    return _handle != INVALID_HANDLE_VALUE;
#else
    _fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
    return _fd >= 0;
#endif
  }

  bool Write(const Byte *bytes, size_t size) {
    size_t done = 0;
    while (done < size) {
#if defined(_WIN32)
      const DWORD chunk = static_cast<DWORD>(std::min<size_t>(size - done, 1u << 20));
      DWORD written = 0;
      if (!WriteFile(_handle, bytes + done, chunk, &written, nullptr) || written == 0)
        return false;
      done += written;
#else
      const ssize_t written = ::write(_fd, bytes + done, size - done);
      if (written > 0) {
        done += static_cast<size_t>(written);
      } else if (written < 0 && errno == EINTR) {
        continue;
      } else {
        return false;
      }
#endif
    }
    return true;
  }

  bool Close() {
#if defined(_WIN32)
    if (_handle == INVALID_HANDLE_VALUE) return true;
    const bool ok = CloseHandle(_handle) != 0;
    _handle = INVALID_HANDLE_VALUE;
    return ok;
#else
    if (_fd < 0) return true;
    const bool ok = ::close(_fd) == 0;
    _fd = -1;
    return ok;
#endif
  }

  ~COutputFile() { Close(); }

 private:
#if defined(_WIN32)
  HANDLE _handle = INVALID_HANDLE_VALUE;
#else
  int _fd = -1;
#endif
};

bool HasLinkOrDirectoryTypeMismatch(const CSzArEx &database, UInt32 index,
    bool isDirectory) {
  if (!SzBitWithVals_Check(&database.Attribs, index)) return false;
  const UInt32 attributes = database.Attribs.Vals[index];
  if ((attributes & FILE_ATTRIBUTE_UNIX_EXTENSION) != 0) {
    const UInt32 unixType = (attributes >> 16) & 0170000u;
    if (unixType == 0120000u) return true;
    if (unixType == 0040000u && !isDirectory) return true;
    if (unixType == 0100000u && isDirectory) return true;
  }
  if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) return true;
  return false;
}

bool LoadEntries(const CSzArEx &database, UInt64 maxOutputBytes,
    std::vector<CEntry> &entries) {
  if (database.NumFiles == 0 || database.NumFiles > kMaxEntries) return false;
  entries.reserve(database.NumFiles);
  UInt64 totalBytes = 0;
  std::vector<UInt16> buffer;
  for (UInt32 i = 0; i < database.NumFiles; ++i) {
    const size_t nameLength = SzArEx_GetFileNameUtf16(&database, i, nullptr);
    if (nameLength < 2 || nameLength > kMaxPathChars + 1) return false;
    buffer.resize(nameLength);
    if (SzArEx_GetFileNameUtf16(&database, i, buffer.data()) != nameLength
        || buffer.back() != 0)
      return false;
    for (size_t j = 0; j + 1 < buffer.size(); ++j)
      if (buffer[j] == 0) return false;

    CEntry entry;
    if (!Utf16ToUtf8(buffer.data(), nameLength - 1, entry.path)
        || !IsSafeRelativePath(entry.path))
      return false;
    entry.folded = FoldPathAscii(entry.path);
    entry.directory = SzArEx_IsDir(&database, i) != 0;
    entry.size = SzArEx_GetFileSize(&database, i);
    if (HasLinkOrDirectoryTypeMismatch(database, i, entry.directory)) return false;
    if (entry.directory && entry.size != 0) return false;
    if (!entry.directory) {
      if (entry.size > std::numeric_limits<size_t>::max()) return false;
      if (entry.size > maxOutputBytes - totalBytes) return false;
      totalBytes += entry.size;
    }
    entries.push_back(std::move(entry));
  }
  return ValidateEntryTree(entries);
}

bool FolderSizesWithinLimit(const CSzArEx &database, UInt64 maxOutputBytes) {
  for (UInt32 folder = 0; folder < database.db.NumFolders; ++folder) {
    if (SzAr_GetFolderUnpackSize(&database.db, folder) > maxOutputBytes) return false;
  }
  return true;
}

} // namespace

static int32_t Extract7zImpl(
    const char *archivePath,
    const char *stagingPath,
    uint64_t maxOutputBytes,
    char *errorBuffer,
    size_t errorBufferSize) {
  SetError(errorBuffer, errorBufferSize, "");
  if (archivePath == nullptr || stagingPath == nullptr || archivePath[0] == '\0'
      || stagingPath[0] == '\0' || maxOutputBytes == 0) {
    SetError(errorBuffer, errorBufferSize, "invalid-arguments");
    return 1;
  }
  if (!IsEmptyDirectory(fs::u8path(stagingPath))) {
    SetError(errorBuffer, errorBufferSize, "staging-not-empty");
    return 2;
  }

  CNativeFileStream input;
  if (!input.Open(archivePath)) {
    SetError(errorBuffer, errorBufferSize, "open-input");
    return 3;
  }

  std::vector<Byte> inputBuffer;
  try {
    inputBuffer.resize(kInputBufferSize);
  } catch (const std::bad_alloc &) {
    SetError(errorBuffer, errorBufferSize, "out-of-memory");
    return 4;
  }
  CLookToRead2 look{};
  LookToRead2_CreateVTable(&look, False);
  look.buf = inputBuffer.data();
  look.bufSize = inputBuffer.size();
  look.realStream = &input.stream.vt;
  LookToRead2_INIT(&look);

  CBoundedAllocator mainAllocator(kHeaderMainAllocationLimit);
  CBoundedAllocator tempAllocator(kHeaderTempAllocationLimit);
  CSzArEx database;
  SzArEx_Init(&database);
  CDatabaseGuard databaseGuard{&database, &mainAllocator.vtable};
  std::call_once(g_CrcTableInit, CrcGenerateTable);
  const SRes openResult = SzArEx_Open(&database, &look.vt,
      &mainAllocator.vtable, &tempAllocator.vtable);
  if (openResult != SZ_OK) {
    const char *label = "open-7z";
    if (openResult == SZ_ERROR_UNSUPPORTED) label = "unsupported-7z-method";
    else if (openResult == SZ_ERROR_ARCHIVE) label = "invalid-7z-header";
    else if (openResult == SZ_ERROR_NO_ARCHIVE) label = "not-7z";
    else if (openResult == SZ_ERROR_CRC) label = "7z-header-crc-failed";
    else if (openResult == SZ_ERROR_INPUT_EOF) label = "truncated-7z";
    else if (openResult == SZ_ERROR_READ) label = "read-7z-failed";
    else if (openResult == SZ_ERROR_MEM) label = "7z-header-allocation-limit";
    SetError(errorBuffer, errorBufferSize, label);
    return 5;
  }

  std::vector<CEntry> entries;
  try {
    if (!FolderSizesWithinLimit(database, maxOutputBytes)) {
      SetError(errorBuffer, errorBufferSize, "unsafe-or-over-limit-entries");
      return 6;
    }
    if (!LoadEntries(database, maxOutputBytes, entries)) {
      SetError(errorBuffer, errorBufferSize, "unsafe-or-over-limit-entries");
      return 6;
    }
  } catch (const std::bad_alloc &) {
    SetError(errorBuffer, errorBufferSize, "out-of-memory");
    return 4;
  }

  const size_t extractionAllocationLimit =
      AllocationLimitWithSlack(maxOutputBytes, kNativeAllocationSlack);
  mainAllocator.SetLimit(extractionAllocationLimit);
  tempAllocator.SetLimit(extractionAllocationLimit);

  UInt32 blockIndex = 0xFFFFFFFF;
  COutputBufferCache outputCache(&mainAllocator.vtable);
  UInt64 writtenTotal = 0;
  const fs::path root = fs::u8path(stagingPath);
  for (UInt32 i = 0; i < entries.size(); ++i) {
    const CEntry &entry = entries[i];
    const fs::path fullPath = root / fs::u8path(entry.path);
    if (!EnsureDirectories(root, entry.path)) {
      SetError(errorBuffer, errorBufferSize, "create-directory");
      break;
    }
    if (entry.directory) {
      std::error_code error;
      if (!fs::create_directory(fullPath, error)) {
        if (error || !fs::is_directory(fs::symlink_status(fullPath, error)) || error) {
          SetError(errorBuffer, errorBufferSize, "create-directory");
          break;
        }
      }
      continue;
    }

    size_t offset = 0;
    size_t outputSize = 0;
    const SRes extractResult = SzArEx_Extract(&database, &look.vt, i,
        &blockIndex, &outputCache.bytes, &outputCache.size, &offset, &outputSize,
        &mainAllocator.vtable, &tempAllocator.vtable);
    if (extractResult != SZ_OK || outputSize != entry.size
        || outputSize > maxOutputBytes - writtenTotal) {
      SetError(errorBuffer, errorBufferSize,
          extractResult == SZ_ERROR_CRC ? "integrity-check-failed" : "extract-7z");
      break;
    }

    if (!EnsureDirectories(root, entry.path)) {
      SetError(errorBuffer, errorBufferSize, "create-directory");
      break;
    }
    COutputFile output;
    if (!output.Open(fullPath)) {
      SetError(errorBuffer, errorBufferSize, "create-file");
      break;
    }
    const Byte *fileBytes = outputSize == 0 ? nullptr : outputCache.bytes + offset;
    if (!output.Write(fileBytes, outputSize) || !output.Close()) {
      SetError(errorBuffer, errorBufferSize, "write-file");
      break;
    }
    writtenTotal += outputSize;
  }

  if (errorBuffer != nullptr && errorBufferSize != 0 && errorBuffer[0] != '\0')
    return 7;
  return 0;
}

extern "C" int32_t pocket_archive_extract_7z(
    const char *archivePath,
    const char *stagingPath,
    uint64_t maxOutputBytes,
    char *errorBuffer,
    size_t errorBufferSize) {
  try {
    return Extract7zImpl(archivePath, stagingPath, maxOutputBytes,
        errorBuffer, errorBufferSize);
  } catch (const std::bad_alloc &) {
    SetError(errorBuffer, errorBufferSize, "out-of-memory");
    return 4;
  } catch (...) {
    SetError(errorBuffer, errorBufferSize, "native-exception");
    return 8;
  }
}
