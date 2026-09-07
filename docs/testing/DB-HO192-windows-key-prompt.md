# Windows Setup product-key prompt

Recipe v2's real native boot passed UEFI and reached Windows Setup, then stopped at the product-key page. The saved answer file selected the exact admitted image index but omitted the separate product-key UI setting. Other `WillShowUI` elements do not apply to this page.

Microsoft documents [ProductKey/WillShowUI](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-setup-userdata-productkey-willshowui) as a separate windowsPE setting whose default is `OnError`. Recipe v3 explicitly selects `Never`. It still provides no installation or activation key, and leaves image selection bound to the admitted WIM index. The [Key setting](https://learn.microsoft.com/en-us/windows-hardware/customize/desktop/unattend/microsoft-windows-setup-userdata-productkey-key) does not support an empty element, so the key is omitted rather than represented as an empty string.

Native qualification on September 6 used candidate `19dedf5cf6b6165c833bc268db267a414d525e05`, the same admitted Windows 11 Pro image, and fresh construction subject `subject-a389dd457970285a68063e81e6040ea8`. At 15:20:35 UTC, its provider console showed Windows installing at approximately 50%, and VHDX allocation had grown from 37,748,736 to 14,365,491,200 bytes. The product-key page was passed without input. Evidence is retained in the operator's `ho193-windows-v3-console.json` and its SHA-256-bound console capture. The earlier attempt and both attempts' original deadlines remain intact.

This proves the prompt fix on the admitted media. Completion, toolchain provisioning, image qualification, and end-to-end Hello World remain separate acceptance steps. The current local activation policy remains `configure-later`.
