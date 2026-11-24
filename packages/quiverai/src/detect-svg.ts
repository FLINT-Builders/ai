/**
 * Checks whether `text` starts with an `<svg` element, optionally preceded by
 * whitespace, XML declarations, comments, and DOCTYPE declarations.
 *
 * The text is scanned once from left to right without backtracking, so the
 * work stays linear in the input length for untrusted data.
 */
export function startsWithSvgElement(text: string): boolean {
  let position = skipWhitespace(text, 0);

  while (position < text.length) {
    if (text.startsWith('<!--', position)) {
      const commentEnd = text.indexOf('-->', position + 4);
      if (commentEnd === -1) {
        return false;
      }
      position = commentEnd + 3;
    } else if (startsWithIgnoreCase(text, '<?xml', position)) {
      const declarationEnd = text.indexOf('?>', position + 5);
      if (declarationEnd === -1) {
        return false;
      }
      position = declarationEnd + 2;
    } else if (startsWithIgnoreCase(text, '<!doctype', position)) {
      const doctypeEnd = findDoctypeEnd(text, position + 9);
      if (doctypeEnd === -1) {
        return false;
      }
      position = doctypeEnd;
    } else {
      return (
        startsWithIgnoreCase(text, '<svg', position) &&
        (text[position + 4] === '>' || isWhitespace(text[position + 4]))
      );
    }

    position = skipWhitespace(text, position);
  }

  return false;
}

/**
 * Checks whether `text` ends with `</svg>` or a self-closing `<svg/>` element,
 * ignoring trailing whitespace. Runs in linear time.
 */
export function endsWithSvgElement(text: string): boolean {
  let end = text.length;
  while (end > 0 && isWhitespace(text[end - 1])) {
    end -= 1;
  }

  if (startsWithIgnoreCase(text, '</svg>', end - 6)) {
    return true;
  }

  if (end < 2 || text[end - 2] !== '/' || text[end - 1] !== '>') {
    return false;
  }

  const tagEnd = end - 2;
  let tagStart = text.indexOf('<', text.lastIndexOf('>', tagEnd - 1) + 1);
  while (tagStart !== -1 && tagStart < tagEnd) {
    if (
      startsWithIgnoreCase(text, '<svg', tagStart) &&
      (tagStart + 4 === tagEnd || isWhitespace(text[tagStart + 4]))
    ) {
      return true;
    }
    tagStart = text.indexOf('<', tagStart + 1);
  }

  return false;
}

/**
 * Returns the position after the `>` that closes a DOCTYPE declaration whose
 * content starts at `position`, skipping quoted literals and the internal
 * subset. Returns -1 when the declaration is not closed.
 */
export function findDoctypeEnd(value: string, position: number) {
  let subsetDepth = 0;
  let quote: '"' | "'" | undefined;

  while (position < value.length) {
    const character = value[position];
    if (quote != null) {
      if (character === quote) {
        quote = undefined;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '[') {
      subsetDepth += 1;
    } else if (character === ']') {
      if (subsetDepth === 0) {
        return -1;
      }
      subsetDepth -= 1;
    } else if (character === '>' && subsetDepth === 0) {
      return position + 1;
    }
    position += 1;
  }

  return -1;
}

/**
 * Compares against a lowercase ASCII `prefix`, folding only ASCII letters
 * (matching the behavior of a non-unicode case-insensitive regular expression).
 */
function startsWithIgnoreCase(
  text: string,
  prefix: string,
  position: number,
): boolean {
  if (position < 0 || position + prefix.length > text.length) {
    return false;
  }

  for (let index = 0; index < prefix.length; index++) {
    const code = text.charCodeAt(position + index);
    const lowerCode = code >= 65 && code <= 90 ? code + 32 : code;
    if (lowerCode !== prefix.charCodeAt(index)) {
      return false;
    }
  }

  return true;
}

function skipWhitespace(text: string, position: number): number {
  while (position < text.length && isWhitespace(text[position])) {
    position += 1;
  }
  return position;
}

function isWhitespace(character: string | undefined): boolean {
  return character != null && /\s/.test(character);
}
