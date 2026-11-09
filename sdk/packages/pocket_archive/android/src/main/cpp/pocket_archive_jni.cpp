#include <jni.h>

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <new>
#include <string>
#include <vector>

#include "pocket_archive_native.h"

namespace {

constexpr size_t kMaxArgumentBytes = 1u << 20;
constexpr size_t kNativeErrorBufferSize = 512;

void SetError(JNIEnv *env, jbyteArray output, const char *message) {
  if (env == nullptr || output == nullptr || message == nullptr) return;
  const jsize capacity = env->GetArrayLength(output);
  if (capacity <= 0) return;
  const size_t messageSize = std::strlen(message);
  const jsize copySize = static_cast<jsize>(
      std::min(messageSize, static_cast<size_t>(capacity - 1)));
  std::vector<jbyte> bytes(static_cast<size_t>(capacity), 0);
  for (jsize i = 0; i < copySize; ++i) {
    bytes[static_cast<size_t>(i)] = static_cast<jbyte>(message[i]);
  }
  env->SetByteArrayRegion(output, 0, capacity, bytes.data());
}

bool ReadUtf8(JNIEnv *env, jbyteArray value, bool allowNull,
              std::string *output) {
  output->clear();
  if (value == nullptr) return allowNull;
  const jsize length = env->GetArrayLength(value);
  if (length <= 0 || static_cast<size_t>(length) > kMaxArgumentBytes) {
    return false;
  }

  std::vector<jbyte> bytes(static_cast<size_t>(length));
  env->GetByteArrayRegion(value, 0, length, bytes.data());
  if (env->ExceptionCheck()) return false;
  for (jbyte byte : bytes) {
    if (byte == 0) return false;
  }
  output->assign(reinterpret_cast<const char *>(bytes.data()), bytes.size());
  std::fill(bytes.begin(), bytes.end(), 0);
  return true;
}

void Clear(std::string *value) {
  volatile char *bytes = value->empty() ? nullptr : value->data();
  for (size_t i = 0; i < value->size(); ++i) bytes[i] = 0;
  value->clear();
}

}  // namespace

extern "C" JNIEXPORT jint JNICALL
Java_dev_pocketjs_pocket_1archive_PocketArchivePlugin_nativeExtract(
    JNIEnv *env, jobject, jbyteArray archivePathUtf8,
    jbyteArray destinationPathUtf8, jbyteArray passwordUtf8,
    jlong maxOutputBytes, jbyteArray errorBuffer) {
  if (env == nullptr || errorBuffer == nullptr) return 1;

  std::string archivePath;
  std::string destinationPath;
  std::string password;
  try {
    if (!ReadUtf8(env, archivePathUtf8, false, &archivePath) ||
        !ReadUtf8(env, destinationPathUtf8, false, &destinationPath) ||
        !ReadUtf8(env, passwordUtf8, true, &password) ||
        maxOutputBytes <= 0) {
      SetError(env, errorBuffer, "invalid-arguments");
      return 1;
    }

    std::vector<char> nativeError(kNativeErrorBufferSize, '\0');
    const char *passwordValue = passwordUtf8 == nullptr ? nullptr : password.c_str();
    const int32_t status = pocket_archive_extract(
        archivePath.c_str(), destinationPath.c_str(), passwordValue,
        static_cast<uint64_t>(maxOutputBytes), nativeError.data(),
        nativeError.size());
    if (status != 0) {
      SetError(env, errorBuffer,
               nativeError.front() == '\0' ? "native-error" : nativeError.data());
    }
    Clear(&password);
    return static_cast<jint>(status);
  } catch (const std::bad_alloc &) {
    Clear(&password);
    SetError(env, errorBuffer, "out-of-memory");
    return 8;
  } catch (const std::exception &) {
    Clear(&password);
    SetError(env, errorBuffer, "native-exception");
    return 9;
  } catch (...) {
    Clear(&password);
    SetError(env, errorBuffer, "native-exception");
    return 9;
  }
}
