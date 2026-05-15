/// Tracks the most-recently-launched commands so Welcome can offer them
/// as one-click chips on the next visit. Keys are normalised (trimmed +
/// collapsed whitespace); empty strings ("plain shell") aren't tracked.

const KEY = "loom.welcome.recentCommands.v1";
const LIMIT = 8;

function load(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .slice(0, LIMIT);
  } catch {
    return [];
  }
}

function save(list: string[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[loom] recent-commands persist failed", err);
  }
}

export function loadRecentCommands(): string[] {
  return load();
}

export function rememberRecentCommands(commands: string[] | undefined): void {
  if (!commands) return;
  const trimmed = commands
    .map((c) => c.trim().replace(/\s+/g, " "))
    .filter((c) => c.length > 0);
  if (trimmed.length === 0) return;
  const seen = load();
  const next: string[] = [];
  for (const c of trimmed) {
    if (!next.includes(c)) next.push(c);
  }
  for (const c of seen) {
    if (!next.includes(c)) next.push(c);
  }
  save(next.slice(0, LIMIT));
}
