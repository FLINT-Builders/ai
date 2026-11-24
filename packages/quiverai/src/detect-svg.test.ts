import { describe, expect, it } from 'vitest';
import { endsWithSvgElement, startsWithSvgElement } from './detect-svg';

describe('startsWithSvgElement', () => {
  it.each([
    '<svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<SVG\n>',
    ' \n\t<svg>',
    '<?xml version="1.0"?><svg>',
    '<?XML version="1.0"?>\n<!-- a --> <!DOCTYPE svg>\n<svg>',
    '<!-- one --><!-- two --><svg>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "a>b"><svg>',
    '<!DOCTYPE svg [<!ENTITY a "b">]><svg>',
    '<!doctype svg><svg>',
    '<!---->'.repeat(1000) + '<svg>',
  ])('accepts %j', text => {
    expect(startsWithSvgElement(text)).toBe(true);
  });

  it.each([
    '',
    '   ',
    'svg',
    '<svgx>',
    '<svg',
    '<html><svg>',
    '<!-- unterminated <svg>',
    '<!--><svg>',
    '<?xml version="1.0" <svg>',
    '<!DOCTYPE svg [<svg>',
    '<?php ?><svg>',
    '<!---->'.repeat(28) + 'x',
  ])('rejects %j', text => {
    expect(startsWithSvgElement(text)).toBe(false);
  });

  it.each([
    ['comments', '<!---->'],
    ['XML declarations', '<?xml?>'],
    ['DOCTYPE declarations', '<!DOCTYPE>'],
    ['mixed preamble', '<?xml?><!----><!DOCTYPE>'],
    ['unterminated comment terminators', '<!--' + '-->'],
  ])('rejects long runs of %s in linear time', (_, unit) => {
    const text = unit.repeat(200_000) + 'x';
    const started = performance.now();
    expect(startsWithSvgElement(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('endsWithSvgElement', () => {
  it.each([
    '<svg></svg>',
    '<svg></SVG>  \n',
    '<svg/>',
    '<svg xmlns="http://www.w3.org/2000/svg" />',
    '<g><svg\nwidth="1"/>',
  ])('accepts %j', text => {
    expect(endsWithSvgElement(text)).toBe(true);
  });

  it.each(['', '<svg>', '<svg></svg>x', '<svgx/>', '<g/>', '<svg><g/>', '/>'])(
    'rejects %j',
    text => {
      expect(endsWithSvgElement(text)).toBe(false);
    },
  );

  it('rejects repeated unclosed svg tags in linear time', () => {
    const text = '<svg /'.repeat(500_000);
    const started = performance.now();
    expect(endsWithSvgElement(text)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
