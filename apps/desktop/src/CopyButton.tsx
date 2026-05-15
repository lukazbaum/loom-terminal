import { useState } from "react";

type Props = {
  text: string;
  align: "left" | "right";
};

/// Hover-revealed copy chip used under chat messages. Caller wraps the
/// surrounding row in a `group` class so the chip fades in on hover.
export function CopyButton({ text, align }: Props) {
  const [copied, setCopied] = useState(false);
  const onClick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // ignore
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy"
      className={`mt-1 flex ${align === "right" ? "justify-end" : "justify-start"} opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100`}
    >
      <span
        className={`rounded-sm px-1.5 py-0.5 font-sans text-[10px] transition-colors duration-100 ${
          copied ? "text-mint" : "text-faint hover:bg-ink-2 hover:text-paper"
        }`}
      >
        {copied ? "copied" : "copy"}
      </span>
    </button>
  );
}
