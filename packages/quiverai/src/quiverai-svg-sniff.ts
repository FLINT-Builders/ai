/**
 * Returns whether `text` starts with an `<svg>` root element, optionally
 * preceded by XML declarations, comments, and DOCTYPE declarations.
 *
 * Runs in linear time: every prolog item ends at its first terminator.
 */
export function startsWithSvgRoot(text: string): boolean {
  let position = skipWhitespace(text, 0);

  while (position < text.length) {
    let end: number;
    if (startsWithIgnoreCase(text, '<?xml', position)) {
      const terminator = text.indexOf('?>', position + 5);
      end = terminator === -1 ? -1 : terminator + 2;
    } else if (text.startsWith('<!--', position)) {
      const terminator = text.indexOf('-->', position + 4);
      end = terminator === -1 ? -1 : terminator + 3;
    } else if (startsWithIgnoreCase(text, '<!DOCTYPE', position)) {
      end = findDoctypeEnd(text, position + 9);
    } else {
      break;
    }

    if (end === -1) {
      return false;
    }
    position = skipWhitespace(text, end);
  }

  return (
    startsWithIgnoreCase(text, '<svg', position) &&
    isSvgTagNameEnd(text[position + 4], true)
  );
}

/**
 * Returns whether trimmed `text` ends with `</svg>` or with a self-closing
 * `<svg/>` tag. Runs in linear time.
 */
export function endsWithSvgRoot(text: string): boolean {
  if (text.slice(-6).toLowerCase() === '</svg>') {
    return true;
  }

  if (!text.endsWith('/>')) {
    return false;
  }

  const tagEnd = text.length - 2;
  const tag = text.slice(text.lastIndexOf('>', tagEnd - 1) + 1, tagEnd);
  const lowerTag = tag.toLowerCase();
  let start = lowerTag.indexOf('<svg');
  while (start !== -1) {
    if (start + 4 === tag.length || isSvgTagNameEnd(tag[start + 4], false)) {
      return true;
    }
    start = lowerTag.indexOf('<svg', start + 4);
  }
  return false;
}

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

function isSvgTagNameEnd(character: string | undefined, allowClose: boolean) {
  return (
    character != null &&
    (/\s/.test(character) || (allowClose && character === '>'))
  );
}

function startsWithIgnoreCase(value: string, prefix: string, position: number) {
  return (
    value.slice(position, position + prefix.length).toLowerCase() ===
    prefix.toLowerCase()
  );
}

function skipWhitespace(value: string, position: number) {
  while (position < value.length && /\s/.test(value[position])) {
    position += 1;
  }
  return position;
}
