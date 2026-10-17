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
  // Revoke on the next tick so the browser can start the download first.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export type CopyResult =
  | { ok: true; method: 'clipboard-api' | 'execCommand' }
  | { ok: false; error: string };

/**
 * Copy text to the clipboard. Prefers the Clipboard API; falls back to a
 * hidden textarea + `document.execCommand('copy')` when the API is missing
 * or rejects (e.g. insecure context / denied permission).
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
    return { ok: false, error: 'Clipboard is not available in this environment.' };
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
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
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const succeeded = document.execCommand('copy');
    document.body.removeChild(textarea);
    if (succeeded) {
      return { ok: true, method: 'execCommand' };
    }
    return {
      ok: false,
      error: 'Copy failed. Select the downloaded report and copy it manually.',
    };
  } catch {
    return {
      ok: false,
      error: 'Clipboard is unavailable in this browser. Try Download Report instead.',
    };
  }
}
