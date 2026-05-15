export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function shortenHome(p: string): string {
  const home = "/Users/";
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf("/");
    if (slash > 0) return `~/${rest.slice(slash + 1)}`;
  }
  return p;
}
