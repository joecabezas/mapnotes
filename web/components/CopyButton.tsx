import { useEffect, useState } from 'react';

/** Copies `text` to the clipboard, showing a check mark for a moment. */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      className="icon-btn"
      data-tip={copied ? 'Copied!' : `Copy ${what}`}
      aria-label={`Copy ${what}`}
      onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
    >
      <svg className="toolbar-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        {copied ? (
          <path d="M20 6 9 17l-5-5" />
        ) : (
          <>
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </>
        )}
      </svg>
    </button>
  );
}
