// Inputs and the check for the markup guarantee every text stripper keeps.

// The guarantee: no `<` that an HTML parser would read as the start of a tag,
// a closing tag, a comment or a declaration, which is a `<` followed by a
// letter, `/`, `!` or `?`. Any other `<` is text to a parser.
export function opensMarkup(text: string): boolean {
  return /<[A-Za-z/!?]/.test(text);
}

// Escapes `<` and `>`, as Commons sends markup that wikitext does not allow.
export const escaped = (text: string): string => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

// mulberry32: a fixed seed keeps a failure reproducible.
export function seeded(start: number): () => number {
  let seed = start;
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A random string over a small alphabet that spells tags, comments and
// declarations, plain `<` and `>`, and entity-escaped brackets.
export function randomMarkup(random: () => number, maxLength = 24): string {
  const alphabet = ['<', '>', '/', '!', '?', 'a', 'b', 'i', 'p', 'r', 's', 'c', 't', ' ', '-', '3', '&lt;', '&gt;', '\u0001', '‮'];
  let text = '';
  const length = 1 + Math.floor(random() * maxLength);
  for (let c = 0; c < length; c++) text += alphabet[Math.floor(random() * alphabet.length)];
  return text;
}

// Uniform random strings rarely nest deeper than a repeated pass reaches, so
// this builds the nesting directly: a tag split at a random point around
// another split tag, up to `maxDepth` deep, with stray text between the layers.
export function nestedMarkup(random: () => number, names: readonly string[], maxDepth = 10): string {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
  const tag = (): string => `<${random() < 0.3 ? '/' : ''}${pick(names)}${pick(['', ' x=1', '/', ' '])}>`;
  const nest = (depth: number): string => {
    if (depth === 0) return random() < 0.5 ? tag() : pick(['', 'x', '<', '>', ' ']);
    const outer = tag();
    const cut = 1 + Math.floor(random() * (outer.length - 1));
    return outer.slice(0, cut) + nest(depth - 1) + pick(['', '', 'x', '<', ' ']) + outer.slice(cut);
  };
  return nest(Math.floor(random() * (maxDepth + 1))) + (random() < 0.3 ? nest(Math.floor(random() * 6)) : '');
}
