const OBJECT_URL_REVOKE_MS = 60_000;

/** Trigger a browser download of a text file via a temporary object URL. */
export function downloadTextFile(
  filename: string,
  contents: string,
  mimeType = 'text/markdown;charset=utf-8',
): void {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Delay revoke: setTimeout(0) can cancel/empty the download in Safari and some Firefox builds.
  window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_MS);
}

export type CopyResult =
  | { ok: true; method: 'clipboard-api' | 'execCommand' }
  | { ok: false; error: string };

const COPY_UNAVAILABLE =
  'Clipboard is unavailable in this browser. Try Download Report instead.';
const COPY_FAILED = 'Copy failed. Try Download Report instead.';

/**
 * Copy text to the clipboard. Prefers the Clipboard API; falls back to a
 * hidden textarea + `document.execCommand('copy')` when the API is missing
 * or rejects (e.g. insecure context / denied permission).
 *
 * Restores focus to the previously focused element after the fallback path.
 */
export async function copyTextToClipboard(text: string): Promise<CopyResult> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: 'clipboard-api' };
    } catch {
      // Fall through to the legacy path.
    }
  }

  if (typeof document === 'undefined') {
    return { ok: false, error: COPY_UNAVAILABLE };
  }

  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.setAttribute('aria-hidden', 'true');
  textarea.tabIndex = -1;
  textarea.style.position = 'fixed';
  textarea.style.top = '0';
  textarea.style.left = '0';
  textarea.style.width = '1px';
  textarea.style.height = '1px';
  textarea.style.padding = '0';
  textarea.style.border = 'none';
  textarea.style.outline = 'none';
  textarea.style.boxShadow = 'none';
  textarea.style.background = 'transparent';
  textarea.style.opacity = '0';

  try {
    document.body.appendChild(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const succeeded = document.execCommand('copy');
    if (succeeded) {
      return { ok: true, method: 'execCommand' };
    }
    return { ok: false, error: COPY_FAILED };
  } catch {
    return { ok: false, error: COPY_UNAVAILABLE };
  } finally {
    textarea.remove();
    previous?.focus({ preventScroll: true });
  }
}
