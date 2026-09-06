# Windows Setup product-key prompt

Recipe v2's real native boot passed UEFI and reached Windows Setup, then stopped at the product-key page. The saved answer file selected the exact admitted image index but omitted the separate product-key UI setting. Other `WillShowUI` elements do not apply to this page.

Microsoft documents [ProductKey/WillShowUI](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-setup-userdata-productkey-willshowui) as a separate windowsPE setting whose default is `OnError`. Recipe v3 explicitly selects `Never`. It still provides no installation or activation key, and leaves image selection bound to the admitted WIM index. The [Key setting](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-setup-userdata-productkey-key) does not support an empty element, so the key is omitted rather than represented as an empty string.

This is a native qualification candidate, not proof that the media supports fully unattended deferred activation. Validate it on a fresh construction subject, preserving the earlier attempt and its deadlines. If Setup reports a missing-key error, retain that exact failure instead of claiming readiness or supplying an activation credential. The current local activation policy remains `configure-later`.
