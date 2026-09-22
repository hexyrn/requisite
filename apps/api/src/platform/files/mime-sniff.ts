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

const SNIFFABLE_MIMES = new Set(SIGNATURES.map((s) => s.mime));

/**
 * True if the declared MIME type is plausible given the actual file bytes.
 *
 * IMPORTANT distinction (found via testing - the original version of this
 * function only compared "what got sniffed" against "what was declared,"
 * which meant content matching NO known signature at all was treated as
 * automatically plausible - so a plain-text file claiming to be
 * `image/png` sailed through, since sniffing it returned null and null was
 * treated as "not a type we check"): if the DECLARED type is one we know
 * how to sniff, the content MUST match that specific signature - sniffing
 * to null is a mismatch, not a pass. Only when the declared type isn't one
 * we have a signature for at all (e.g. text/plain, text/csv) do we skip
 * the check and defer entirely to the MIME allowlist.
 */
export function mimeTypeMatchesContent(declaredMime: string, buffer: Buffer): boolean {
  const isOfficeDoc = declaredMime.includes('officedocument');
  if (!SNIFFABLE_MIMES.has(declaredMime) && !isOfficeDoc) {
    return true; // not a type we sniff - allow, still subject to the MIME allowlist
  }
  const sniffed = sniffMimeType(buffer);
  if (isOfficeDoc) return sniffed === 'application/zip'; // office formats are zip containers
  return sniffed === declaredMime;
}
