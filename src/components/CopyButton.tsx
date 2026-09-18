"use client";

import { useState } from "react";

// The only client component in this app — copying to the clipboard is
// inherently a browser action (navigator.clipboard), nothing here needs
// to be interactive beyond that.
export default function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      className="button-secondary"
      style={{ padding: "6px 12px", fontSize: 13 }}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // Clipboard API can fail (no permission, insecure context) —
          // nothing to do but leave the address selectable as text.
        }
      }}
    >
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}
