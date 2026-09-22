/**
 * Minimal magic-byte MIME sniffing - "do not trust filename extensions
 * alone" (P1 item 13). This is deliberately small: it recognises common
 * safe types by their real file signature and is used to REJECT an upload
 * whose claimed Content-Type doesn't match its actual bytes, not as a
 * general-purpose file-type detection library. Unknown-but-plausible
 * binary types fall back to the declared Content-Type (still subject to
 * the MIME allowlist in FileService).
 */
const SIGNATURES: { mime: string; bytes: number[]; offset?: number }[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] }, // also docx/xlsx (zip-based) - checked more specifically at the app layer if ever needed
];

export function sniffMimeType(buffer: Buffer): string | null {
  for (const sig of SIGNATURES) {
    const offset = sig.offset ?? 0;
    if (buffer.length >= offset + sig.bytes.length && sig.bytes.every((b, i) => buffer[offset + i] === b)) {
      return sig.mime;
    }
  }
  return null;
}

/** True if the declared MIME type is plausible given the actual file bytes (or the type isn't one we sniff, in which case we don't second-guess it). */
export function mimeTypeMatchesContent(declaredMime: string, buffer: Buffer): boolean {
  const sniffed = sniffMimeType(buffer);
  if (!sniffed) return true; // not a type we sniff - allow, still subject to the MIME allowlist
  if (sniffed === 'application/zip' && (declaredMime.includes('officedocument') || declaredMime === 'application/zip')) return true;
  return sniffed === declaredMime;
}
