#include "CPP/7zip/Archive/StdAfx.h"

#include <algorithm>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cwchar>
#include <dirent.h>
#include <cstring>
#include <fcntl.h>
#include <set>
#include <map>
#include <new>
#include <string>
#include <sys/stat.h>
#include <unistd.h>
#include <vector>

#include "CPP/Common/MyCom.h"
#include "CPP/Common/StringConvert.h"
#include "CPP/Windows/PropVariant.h"
#include "CPP/7zip/Common/FileStreams.h"
#include "CPP/7zip/Archive/IArchive.h"
#include "CPP/7zip/IPassword.h"
#include "pocket_archive_native.h"

extern "C" HRESULT CreateArchiver(const GUID *clsid, const GUID *iid, void **outObject);
extern "C" void pocket_archive_force_link_zip_register();

static const GUID kZipHandler = {
    0x23170F69, 0x40C1, 0x278A,
    { 0x10, 0x00, 0x00, 0x01, 0x10, 0x01, 0x00, 0x00 } };

namespace {

static const UInt32 kMaxPathChars = 4096;
static const UInt32 kMaxEntryCount = 100000;

static void SetError(char *buffer, size_t bufferSize, const char *message)
{
  if (!buffer || bufferSize == 0)
    return;
  if (!message)
    message = "native-error";
  std::strncpy(buffer, message, bufferSize - 1);
  buffer[bufferSize - 1] = 0;
}

static bool IsTruthy(const PROPVARIANT &prop)
{
  return prop.vt == VT_BOOL && prop.boolVal != VARIANT_FALSE;
}

static bool IsLinkProperty(const PROPVARIANT &prop)
{
  if (prop.vt == VT_BSTR)
    return prop.bstrVal != NULL && prop.bstrVal[0] != 0;
  if (prop.vt == VT_BOOL)
    return prop.boolVal != VARIANT_FALSE;
  return false;
}

static bool IsSafePath(const UString &path)
{
  const unsigned length = path.Len();
  if (length == 0 || length > kMaxPathChars)
    return false;
  if (path[0] == L'/' || path[0] == L'\\')
    return false;
  if (length >= 2 && path[1] == L':')
    return false;
  for (unsigned i = 0; i < length; ++i)
  {
    const wchar_t c = path[i];
    if (c == 0 || c == L'\\')
      return false;
  }

  unsigned segmentStart = 0;
  for (unsigned i = 0; i <= length; ++i)
  {
    if (i != length && path[i] != L'/')
      continue;
    const unsigned segmentLength = i - segmentStart;
    if (segmentLength == 0)
      return false;
    if (segmentLength == 1 && path[segmentStart] == L'.')
      return false;
    if (segmentLength == 2 && path[segmentStart] == L'.' && path[segmentStart + 1] == L'.')
      return false;
    segmentStart = i + 1;
  }
  return true;
}

static std::string FoldPath(const UString &path)
{
  std::string folded;
  AString utf8 = UnicodeStringToMultiByte(path, CP_UTF8);
  folded.assign(utf8.Ptr(), utf8.Len());
  for (char &c : folded)
  {
    if (c >= 'A' && c <= 'Z')
      c = static_cast<char>(c + ('a' - 'A'));
  }
  return folded;
}

static std::string Utf8Path(const UString &path)
{
  AString utf8 = UnicodeStringToMultiByte(path, CP_UTF8);
  return std::string(utf8.Ptr(), utf8.Len());
}

static bool IsDirectoryMode(UInt32 mode)
{
  return (mode & 0170000u) == 0040000u;
}

static bool IsSymlinkMode(UInt32 mode)
{
  return (mode & 0170000u) == 0120000u;
}

class CPasswordCallback final:
    public IArchiveOpenCallback,
    public ICryptoGetTextPassword,
    public CMyUnknownImp
{
  Z7_IFACES_IMP_UNK_2(IArchiveOpenCallback, ICryptoGetTextPassword)

public:
  bool PasswordIsDefined = false;
  UString Password;
};

Z7_COM7F_IMF(CPasswordCallback::SetTotal(const UInt64 *, const UInt64 *))
{
  return S_OK;
}

Z7_COM7F_IMF(CPasswordCallback::SetCompleted(const UInt64 *, const UInt64 *))
{
  return S_OK;
}

Z7_COM7F_IMF(CPasswordCallback::CryptoGetTextPassword(BSTR *password))
{
  if (!PasswordIsDefined)
    return E_ABORT;
  return StringToBstr(Password, password);
}

class CPosixOutput final : public ISequentialOutStream, public CMyUnknownImp
{
  Z7_IFACES_IMP_UNK_1(ISequentialOutStream)
  int _fd;
  bool _closeOk;
  UInt64 *_totalWritten;
  UInt64 _maxOutputBytes;

public:
  CPosixOutput(const std::string &path, UInt64 *totalWritten,
      UInt64 maxOutputBytes): _fd(-1), _closeOk(true),
      _totalWritten(totalWritten), _maxOutputBytes(maxOutputBytes)
  {
    _fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  }

  ~CPosixOutput()
  {
    Close();
  }

  bool IsOpen() const { return _fd >= 0; }

  bool Close()
  {
    if (_fd < 0)
      return _closeOk;
    const int result = ::close(_fd);
    _fd = -1;
    if (result != 0)
      _closeOk = false;
    return _closeOk;
  }
};

Z7_COM7F_IMF(CPosixOutput::Write(const void *data, UInt32 size, UInt32 *processedSize))
{
  if (processedSize)
    *processedSize = 0;
  if (!_totalWritten || *_totalWritten > _maxOutputBytes
      || size > _maxOutputBytes - *_totalWritten)
    return E_FAIL;
  const Byte *bytes = static_cast<const Byte *>(data);
  UInt32 done = 0;
  while (done < size)
  {
    const ssize_t count = ::write(_fd, bytes + done, size - done);
    if (count > 0)
    {
      done += static_cast<UInt32>(count);
      continue;
    }
    if (count < 0 && errno == EINTR)
      continue;
    if (processedSize)
      *processedSize = done;
    return E_FAIL;
  }
  if (processedSize)
    *processedSize = done;
  *_totalWritten += done;
  return S_OK;
}

struct CItemInfo
{
  UString Path;
  std::string Utf8;
  std::string Folded;
  bool IsDir = false;
  UInt64 Size = 0;
};

static bool CheckNoSymlinkDirectory(const std::string &path)
{
  struct stat st;
  if (::lstat(path.c_str(), &st) != 0)
    return errno == ENOENT && ::mkdir(path.c_str(), 0700) == 0;
  return S_ISDIR(st.st_mode) && !S_ISLNK(st.st_mode);
}

static bool EnsureParentDirectories(const std::string &root, const std::string &relative)
{
  size_t slash = relative.find('/');
  while (slash != std::string::npos)
  {
    const std::string part = relative.substr(0, slash);
    const std::string path = root + "/" + part;
    if (!CheckNoSymlinkDirectory(path))
      return false;
    slash = relative.find('/', slash + 1);
  }
  return true;
}

static bool IsEmptyDirectory(const char *path)
{
  struct stat st;
  if (::lstat(path, &st) != 0 || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode))
    return false;
  DIR *dir = ::opendir(path);
  if (!dir)
    return false;
  bool empty = true;
  while (struct dirent *entry = ::readdir(dir))
  {
    if (std::strcmp(entry->d_name, ".") != 0 && std::strcmp(entry->d_name, "..") != 0)
    {
      empty = false;
      break;
    }
  }
  ::closedir(dir);
  return empty;
}

class CExtractCallback final:
    public IArchiveExtractCallback,
    public ICryptoGetTextPassword,
    public CMyUnknownImp
{
  Z7_IFACES_IMP_UNK_2(IArchiveExtractCallback, ICryptoGetTextPassword)
  Z7_IFACE_COM7_IMP(IProgress)

  std::string _root;
  std::vector<CItemInfo> _items;
  CMyComPtr<ISequentialOutStream> _out;
  CPosixOutput *_outputNative = nullptr;
  bool _failed = false;
  bool _outputCloseFailed = false;
  Int32 _lastResult = NArchive::NExtract::NOperationResult::kOK;
  UString _password;
  bool _passwordDefined = false;
  UInt64 _maxOutputBytes = 0;
  UInt64 _totalWritten = 0;

public:
  void Init(const std::string &root,
      const std::vector<CItemInfo> &items, const char *password,
      UInt64 maxOutputBytes)
  {
    _root = root;
    _items = items;
    _passwordDefined = password != NULL;
    _maxOutputBytes = maxOutputBytes;
    if (_passwordDefined)
      _password = MultiByteToUnicodeString(password, CP_UTF8);
  }

  bool Failed() const { return _failed || _outputCloseFailed; }
  Int32 LastResult() const { return _lastResult; }

  void FinalizeOutput()
  {
    if (_outputNative && !_outputNative->Close())
      _outputCloseFailed = true;
    _outputNative = nullptr;
    _out.Release();
  }
};

Z7_COM7F_IMF(CExtractCallback::SetTotal(UInt64))
{
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::SetCompleted(const UInt64 *))
{
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::GetStream(UInt32 index,
    ISequentialOutStream **outStream, Int32 askExtractMode))
{
  if (!outStream || index >= _items.size())
    return E_INVALIDARG;
  *outStream = NULL;
  FinalizeOutput();
  if (askExtractMode != NArchive::NExtract::NAskMode::kExtract)
    return S_OK;
  const CItemInfo &item = _items[index];
  const std::string fullPath = _root + "/" + item.Utf8;
  if (item.IsDir)
  {
    if (!EnsureParentDirectories(_root, item.Utf8))
      return E_FAIL;
    struct stat st;
    if (::lstat(fullPath.c_str(), &st) == 0)
      return (S_ISDIR(st.st_mode) && !S_ISLNK(st.st_mode)) ? S_OK : E_FAIL;
    if (::mkdir(fullPath.c_str(), 0700) != 0 && errno != EEXIST)
      return E_FAIL;
    if (::lstat(fullPath.c_str(), &st) != 0 || !S_ISDIR(st.st_mode) || S_ISLNK(st.st_mode))
      return E_FAIL;
    return S_OK;
  }
  if (!EnsureParentDirectories(_root, item.Utf8))
    return E_FAIL;
  CPosixOutput *outputSpec = new CPosixOutput(fullPath,
      &_totalWritten, _maxOutputBytes);
  if (!outputSpec->IsOpen())
  {
    delete outputSpec;
    return E_FAIL;
  }
  CMyComPtr<ISequentialOutStream> output(outputSpec);
  _outputNative = outputSpec;
  _out = output;
  *outStream = output.Detach();
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::PrepareOperation(Int32))
{
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::SetOperationResult(Int32 result))
{
  FinalizeOutput();
  if (result != NArchive::NExtract::NOperationResult::kOK)
  {
    _failed = true;
    _lastResult = result;
  }
  return S_OK;
}

Z7_COM7F_IMF(CExtractCallback::CryptoGetTextPassword(BSTR *password))
{
  if (!_passwordDefined)
    return E_ABORT;
  return StringToBstr(_password, password);
}

static bool GetItemInfo(IInArchive *archive, UInt32 index, CItemInfo &item)
{
  NWindows::NCOM::CPropVariant pathProp;
  if (archive->GetProperty(index, kpidPath, &pathProp) != S_OK || pathProp.vt != VT_BSTR)
    return false;
  const UINT bstrLength = SysStringLen(pathProp.bstrVal);
  if (!pathProp.bstrVal || bstrLength == 0 || bstrLength > kMaxPathChars)
    return false;
  for (UINT i = 0; i < bstrLength; ++i)
  {
    if (pathProp.bstrVal[i] == 0)
      return false;
  }
  // Keep the length supplied by the archive property in sync with the
  // NUL-terminated view used by UString. An embedded NUL must never be
  // silently truncated into a different output path.
  if (std::wcslen(pathProp.bstrVal) != bstrLength)
    return false;
  item.Path = pathProp.bstrVal;
  if (!IsSafePath(item.Path))
    return false;
  item.Utf8 = Utf8Path(item.Path);
  item.Folded = FoldPath(item.Path);
  if (item.Utf8.empty() || item.Utf8.size() > kMaxPathChars)
    return false;
  NWindows::NCOM::CPropVariant dirProp;
  if (archive->GetProperty(index, kpidIsDir, &dirProp) != S_OK || dirProp.vt != VT_BOOL)
    return false;
  item.IsDir = IsTruthy(dirProp);
  NWindows::NCOM::CPropVariant sizeProp;
  if (archive->GetProperty(index, kpidSize, &sizeProp) != S_OK
      || sizeProp.vt != VT_UI8)
    return false;
  item.Size = sizeProp.uhVal.QuadPart;
  if (item.IsDir && item.Size != 0)
    return false;

  NWindows::NCOM::CPropVariant linkProp;
  if (archive->GetProperty(index, kpidSymLink, &linkProp) == S_OK && IsLinkProperty(linkProp))
    return false;
  linkProp = NWindows::NCOM::CPropVariant();
  if (archive->GetProperty(index, kpidHardLink, &linkProp) == S_OK && IsLinkProperty(linkProp))
    return false;
  NWindows::NCOM::CPropVariant posixProp;
  if (archive->GetProperty(index, kpidPosixAttrib, &posixProp) == S_OK
      && posixProp.vt == VT_UI4)
  {
    const UInt32 mode = posixProp.ulVal;
    if (IsSymlinkMode(mode))
      return false;
    if (IsDirectoryMode(mode) && !item.IsDir)
      return false;
  }
  return !item.Utf8.empty();
}

static bool ValidateItems(IInArchive *archive, std::vector<CItemInfo> &items,
    UInt64 maxOutputBytes)
{
  UInt32 count = 0;
  if (archive->GetNumberOfItems(&count) != S_OK || count == 0
      || count > kMaxEntryCount)
    return false;
  items.reserve(count);
  std::set<std::string> seen;
  std::set<std::string> folded;
  UInt64 totalBytes = 0;
  for (UInt32 i = 0; i < count; ++i)
  {
    CItemInfo item;
    if (!GetItemInfo(archive, i, item))
      return false;
    if (!seen.insert(item.Utf8).second || !folded.insert(item.Folded).second)
      return false;
    if (!item.IsDir)
    {
      if (item.Size > maxOutputBytes - totalBytes)
        return false;
      totalBytes += item.Size;
    }
    items.push_back(item);
  }

  std::map<std::string, std::string> typeByPath;
  for (const CItemInfo &item : items)
    typeByPath[item.Folded] = item.IsDir ? "dir" : "file";
  for (const CItemInfo &item : items)
  {
    size_t slash = item.Folded.find('/');
    while (slash != std::string::npos)
    {
      const std::string parent = item.Folded.substr(0, slash);
      auto it = typeByPath.find(parent);
      if (it != typeByPath.end() && it->second != "dir")
        return false;
      slash = item.Folded.find('/', slash + 1);
    }
  }
  return true;
}

} // namespace

extern "C" int32_t pocket_archive_extract_zip(const char *zipPath,
    const char *stagingPath, const char *password, uint64_t maxOutputBytes,
    char *errorBuffer, size_t errorBufferSize)
{
  SetError(errorBuffer, errorBufferSize, "");
  try
  {
    if (!zipPath || !stagingPath || zipPath[0] == 0 || stagingPath[0] == 0
        || maxOutputBytes == 0)
    {
      SetError(errorBuffer, errorBufferSize, "invalid-arguments");
      return 1;
    }
    if (!IsEmptyDirectory(stagingPath))
    {
      SetError(errorBuffer, errorBufferSize, "staging-not-empty");
      return 2;
    }

    CInFileStream *inputSpec = new CInFileStream;
    CMyComPtr<IInStream> input(inputSpec);
    if (!inputSpec->Open(zipPath))
    {
      SetError(errorBuffer, errorBufferSize, "open-input");
      return 3;
    }

    CMyComPtr<IInArchive> archive;
    pocket_archive_force_link_zip_register();
    HRESULT hr = CreateArchiver(&kZipHandler, &IID_IInArchive, (void **)&archive);
    if (hr != S_OK || !archive)
    {
      SetError(errorBuffer, errorBufferSize, "zip-handler-unavailable");
      return 4;
    }

    CPasswordCallback *openSpec = new CPasswordCallback;
    CMyComPtr<IArchiveOpenCallback> openCallback(openSpec);
    openSpec->PasswordIsDefined = password != NULL;
    if (password)
      openSpec->Password = MultiByteToUnicodeString(password, CP_UTF8);
    hr = archive->Open(input, NULL, openCallback);
    if (hr != S_OK)
    {
      archive->Close();
      SetError(errorBuffer, errorBufferSize, "open-zip");
      return 5;
    }

    std::vector<CItemInfo> items;
    if (!ValidateItems(archive, items, maxOutputBytes))
    {
      archive->Close();
      SetError(errorBuffer, errorBufferSize, "unsafe-entries");
      return 6;
    }

    CExtractCallback *extractSpec = new CExtractCallback;
    CMyComPtr<IArchiveExtractCallback> extractCallback(extractSpec);
    extractSpec->Init(stagingPath, items, password, maxOutputBytes);
    hr = archive->Extract(NULL, (UInt32)(Int32)(-1), false, extractCallback);
    extractSpec->FinalizeOutput();
    archive->Close();
    if (hr != S_OK || extractSpec->Failed())
    {
      if (extractSpec->LastResult() == NArchive::NExtract::NOperationResult::kWrongPassword)
        SetError(errorBuffer, errorBufferSize, "wrong-password");
      else if (extractSpec->Failed())
        SetError(errorBuffer, errorBufferSize, "integrity-check-failed");
      else
        SetError(errorBuffer, errorBufferSize, "extract-failed");
      return 7;
    }
    return 0;
  }
  catch (const std::bad_alloc &)
  {
    SetError(errorBuffer, errorBufferSize, "out-of-memory");
    return 8;
  }
  catch (...)
  {
    SetError(errorBuffer, errorBufferSize, "native-exception");
    return 9;
  }
}
