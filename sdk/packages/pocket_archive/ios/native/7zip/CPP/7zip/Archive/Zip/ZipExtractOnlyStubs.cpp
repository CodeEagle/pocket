// Extraction-only link stubs: ZIP writing is not included in this build.
#include "StdAfx.h"
#include "ZipHandler.h"

namespace NArchive { namespace NZip {

Z7_COM7F_IMF(CHandler::UpdateItems(ISequentialOutStream *, UInt32, IArchiveUpdateCallback *))
{
  return E_NOTIMPL;
}

Z7_COM7F_IMF(CHandler::GetFileTimeType(UInt32 *))
{
  return E_NOTIMPL;
}

Z7_COM7F_IMF(CHandler::SetProperties(const wchar_t * const *, const PROPVARIANT *, UInt32))
{
  return E_NOTIMPL;
}

}}
