# Hyper-V console length prefix

On 2026-09-06 the Windows construction VM remained at its initial 4 MiB disk allocation. Console collection failed because the adapter treated four extra bytes as a required zero trailer. The actual 320×240 provider response was 153,604 bytes, started `00 02 58 04`, and ended with nonzero white pixels. A separate 64×64 request returned 8,196 bytes starting `00 00 20 04`. In each case the prefix is the total buffer length in big-endian order, not dimensions or pixels.

This corrects the interpretation in HO005 section 13 and the 2026-08-27 assessment. Their historical observations remain evidence, but their zero-trailer explanation was wrong. The earlier `512x1112` interpretation of the same bytes was also wrong: those are the little-endian halves of the 153,604-byte length.

Microsoft [documents RGB565 image data](https://learn.microsoft.com/en-us/windows/win32/hyperv_v2/getvirtualsystemthumbnailimage-msvm-virtualsystemmanagementservice). The four-byte framing is a native observation on this host, not a claim made by that documentation. The adapter supports the documented exact pixel length and the observed exact pixel length plus a matching big-endian total length. It rejects other sizes, incorrect prefixes, dimensions and encodings. It never derives dimensions from pixel values. Tests check both first and last pixels and unchanged VM/media state.

This is diagnostic evidence only. Console contents cannot authorize VM changes or establish successful installation. The existing construction owner, media identity, disk identity and deadlines still govern subsequent actions.
