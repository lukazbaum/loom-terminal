/// Tiny 4-quadrant palette swatch. Background / accent / success /
/// danger, in that order — picked so themes are distinguishable in a
/// list without having to read the name. Reused by the App's theme
/// picker trigger / dropdown and by the editor's theme list.
import type { ThemeTokens } from "./themes";

type Size = "sm" | "md";

const SIZE_CLASS: Record<Size, string> = {
  sm: "h-[18px] w-[18px]",
  md: "h-7 w-7",
};

export function ThemeChip({
  tokens,
  size = "sm",
}: {
  tokens: ThemeTokens;
  size?: Size;
}) {
  return (
    <span
      aria-hidden
      className={`grid shrink-0 grid-cols-2 grid-rows-2 overflow-hidden border border-rule/60 ${SIZE_CLASS[size]}`}
    >
      <span style={{ backgroundColor: tokens.ink0 }} />
      <span style={{ backgroundColor: tokens.amber }} />
      <span style={{ backgroundColor: tokens.mint }} />
      <span style={{ backgroundColor: tokens.coral }} />
    </span>
  );
}
