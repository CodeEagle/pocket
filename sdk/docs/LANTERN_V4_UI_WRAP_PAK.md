# Lantern v4 UI-wrap PAK comparison

The UI-wrap build's PAK differs from the full-body reference by 16 bytes, not
by media or model texture content. Both frozen inputs were read with the pinned
compiler's `framework/compiler/pak.ts::unpack()` implementation and checked
against the v1 PAK header, directory, name ranges, payload ranges, FNV key
hashes, unique keys and 16-byte blob alignment.

| PAK | Bytes | SHA-256 | Entries |
| --- | ---: | --- | ---: |
| Full-body reference | 69,193,344 | `8126d148c8f71d573dbae11927647150d8d96922f88bab48074d018299369c08` | 36 |
| UI-wrap candidate | 69,193,360 | `5162ed5f65eae7ee6623931be1042b47bf4ab40e5ee1f847d67d61d0872488d1` | 36 |

There are no added or removed entries. The only changed entry is `ui:styles`:
its payload grows from 25,673 bytes to 25,687 bytes (+14). The PAK stores aligned
blob extents; this styles blob's allocation grows by 16 bytes after alignment,
which accounts for the exact container-size delta.

All 22 `ui:img.*` entries are byte-identical across the two PAKs, including
their payload hashes. In particular, all 18 media/model images—the two Hiyori
Live2D texture pages and the 16 non-UI story/atmosphere image entries—are
byte-identical. The four `art/ui/` skin image entries are identical as well.
The complete per-entry comparison and PAK validation facts are preserved in
the ignored report
[`pak-comparison.json`](../.pocket-build/lantern-v4-ui-wrap-20261108/pak-comparison.json).

This confirms the PAK is structurally valid and that the 16-byte container
growth comes from UI style data and its alignment. It does not establish
staging identity or any runtime/platform behavior; the failed staging attempt
was separately restored to the complete prior three-file artifact set.
