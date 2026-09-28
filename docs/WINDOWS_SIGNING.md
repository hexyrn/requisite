# Authenticode signing (Hexyrn internal)

`Requisite-Setup.exe` must be signed before it is given to a customer. Unsigned installers trigger Windows
SmartScreen / "Unknown publisher" warnings and customers are told to reject them (see `INSTALL_WINDOWS.md`, step 1).

## What Hexyrn must obtain (not in this repository)

1. **A code-signing certificate** issued to Hexyrn by a public CA: an **EV code-signing certificate** (recommended:
   SmartScreen reputation is immediate) or OV. Since 2023 the private key must live on a hardware token / HSM, or in
   a cloud signing service (Azure Trusted Signing, DigiCert KeyLocker, SSL.com eSigner …).
2. A **Windows machine with the Windows SDK** (`signtool.exe`) or the cloud signer's client, where the build runs.
3. A **timestamp server** (the build script uses `http://timestamp.digicert.com`) so signatures stay valid after the
   certificate expires.
4. **Secret handling**: the certificate/PIN lives in the signing environment (CI secret store or token), never in
   the repository. `-SigningCertPath`/`-SigningCertPassword` handle a `.pfx` for the OV-in-a-file/lab case; with a
   hardware token or cloud signer, replace the `signtool sign` lines in `scripts/windows/build-release.ps1` with the
   provider's command (same three places: MSI, Burn engine, bundle).

There are **no development or self-signed certificates in the repository or in any release build.**

## Build kinds

| Command                                                                | Output                                    | For customers?                                |
| ---------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------- |
| `build-release.ps1 …` (no `-Release`)                                  | `Requisite-Setup-UNSIGNED-TEST.exe`       | **No** — internal testing only                |
| `build-release.ps1 -Release -SigningCertPath … -SigningCertPassword …` | `Requisite-Setup.exe` (signed + verified) | Yes, after the clean-VM acceptance run passes |

`-Release` **fails** if no certificate is supplied, so an unsigned file can never be named `Requisite-Setup.exe`.
Signing order in the script: MSI → detach Burn engine → sign engine → re-attach → sign the bundle →
`signtool verify /pa`. After signing, record the SHA-256 in the release notes and, if release manifests are used,
sign that separately (`docs/RELEASE_SIGNING.md`).

## Licence signing is a different key

The **licence** private key (Ed25519) is Hexyrn's, is used only by `npm run licence` on a Hexyrn machine, and is
never part of any installer. Only the matching public key is baked into `Requisite-Setup.exe`
(`build-release.ps1 -LicencePublicKeyFile`). Do not reuse the Authenticode key for licences or vice-versa.
