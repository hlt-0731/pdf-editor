/**
 * Tests for rebuildTextOperators — verifies that text edits are correctly
 * mapped back to PDF content stream operators.
 *
 * After the splitByOperator change, each TextBlock maps to exactly one
 * Tj/TJ operator.  The rebuild is a direct 1:1 replacement.
 */

import { describe, it, expect } from 'vitest';
import { rebuildTextOperators, serializeOperators } from './save';
import type { ContentOperator } from '../../core/content/operators';
import type { TextBlock, TextChar } from '../../model/text-block';
import { PDFObjectType } from '../../core/objects/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal TextChar for testing. */
function mkChar(
  char: string,
  operatorIndex: number,
  fontName = 'F1',
): TextChar {
  return {
    char,
    glyphId: char.codePointAt(0) ?? 0,
    x: 0,
    y: 0,
    width: 10,
    height: 12,
    fontSize: 12,
    fontName,
    color: [0, 0, 0],
    matrix: [1, 0, 0, 1, 0, 0],
    operatorIndex,
  };
}

/** Create a Tj operator with a literal string. */
function mkTjOp(text: string, index: number): ContentOperator {
  const raw = new TextEncoder().encode(`(${text}) Tj`);
  return {
    name: 'Tj',
    operands: [{
      type: PDFObjectType.String,
      value: text,
      raw: new TextEncoder().encode(text),
    }],
    raw,
    offset: index * 100,
    modified: false,
  };
}

/** Create a non-text operator (e.g. Tf, Td, BT). */
function mkOtherOp(name: string, index: number): ContentOperator {
  const raw = new TextEncoder().encode(name);
  return {
    name,
    operands: [],
    raw,
    offset: index * 100,
    modified: false,
  };
}

/** Build a single-operator TextBlock from chars with the given new text. */
function mkBlock(chars: TextChar[], newText: string): TextBlock {
  return {
    id: 'tb_0',
    chars,
    boundingBox: { x: 0, y: 0, width: 100, height: 20 },
    fontName: chars[0]?.fontName ?? 'F1',
    fontSize: 12,
    text: newText,
    editable: true,
    modified: true,
    color: [0, 0, 0],
    lineBreaks: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rebuildTextOperators (single-operator blocks)', () => {
  it('replace one character in the middle', () => {
    // "Hello" → "Hallo"
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hello', 1),
      mkOtherOp('ET', 2),
    ];
    const chars = [
      mkChar('H', 1), mkChar('e', 1), mkChar('l', 1),
      mkChar('l', 1), mkChar('o', 1),
    ];
    const block = mkBlock(chars, 'Hallo');

    const result = rebuildTextOperators(operators, [block]);

    expect(result[1]!.modified).toBe(true);
    expect(result[1]!.name).toBe('Tj');
    expect(result[0]!.modified).toBe(false);
    expect(result[2]!.modified).toBe(false);

    const operand = result[1]!.operands[0]!;
    if (operand.type === PDFObjectType.String) {
      expect(operand.value).toBe('Hallo');
    }
  });

  it('shorten text', () => {
    // "Hello" → "Hi"
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hello', 1),
      mkOtherOp('ET', 2),
    ];
    const chars = [
      mkChar('H', 1), mkChar('e', 1), mkChar('l', 1),
      mkChar('l', 1), mkChar('o', 1),
    ];
    const block = mkBlock(chars, 'Hi');

    const result = rebuildTextOperators(operators, [block]);

    expect(result[1]!.modified).toBe(true);
    const operand = result[1]!.operands[0]!;
    if (operand.type === PDFObjectType.String) {
      expect(operand.value).toBe('Hi');
    }
  });

  it('lengthen text (insertion)', () => {
    // "Hi" → "Hello"
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hi', 1),
      mkOtherOp('ET', 2),
    ];
    const chars = [mkChar('H', 1), mkChar('i', 1)];
    const block = mkBlock(chars, 'Hello');

    const result = rebuildTextOperators(operators, [block]);

    expect(result[1]!.modified).toBe(true);
    const operand = result[1]!.operands[0]!;
    if (operand.type === PDFObjectType.String) {
      expect(operand.value).toBe('Hello');
    }
  });

  it('complete replacement', () => {
    // "Hello" → "XY"
    const operators: ContentOperator[] = [mkTjOp('Hello', 0)];
    const chars = [
      mkChar('H', 0), mkChar('e', 0), mkChar('l', 0),
      mkChar('l', 0), mkChar('o', 0),
    ];
    const block = mkBlock(chars, 'XY');

    const result = rebuildTextOperators(operators, [block]);

    expect(result[0]!.modified).toBe(true);
    const operand = result[0]!.operands[0]!;
    if (operand.type === PDFObjectType.String) {
      expect(operand.value).toBe('XY');
    }
  });

  it('delete all text (empty string)', () => {
    const operators: ContentOperator[] = [mkTjOp('Hello', 0)];
    const chars = [
      mkChar('H', 0), mkChar('e', 0), mkChar('l', 0),
      mkChar('l', 0), mkChar('o', 0),
    ];
    const block = mkBlock(chars, '');

    const result = rebuildTextOperators(operators, [block]);

    expect(result[0]!.modified).toBe(true);
    const operand = result[0]!.operands[0]!;
    if (operand.type === PDFObjectType.String) {
      expect(operand.value).toBe('');
    }
  });

  it('edit one block does NOT affect the other operator', () => {
    // Two separate blocks (split by operator), edit only the first
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hello', 1),
      mkOtherOp('Td', 2),
      mkTjOp('World', 3),
      mkOtherOp('ET', 4),
    ];
    // Block for operator 1 only
    const chars1 = [
      mkChar('H', 1), mkChar('e', 1), mkChar('l', 1),
      mkChar('l', 1), mkChar('o', 1),
    ];
    const block1 = mkBlock(chars1, 'Hallo');

    const result = rebuildTextOperators(operators, [block1]);

    // Op 1 modified
    expect(result[1]!.modified).toBe(true);
    const op1Operand = result[1]!.operands[0]!;
    if (op1Operand.type === PDFObjectType.String) {
      expect(op1Operand.value).toBe('Hallo');
    }
    // Op 3 ("World") untouched
    expect(result[3]!.modified).toBe(false);
  });

  it('edit two blocks independently in same stream', () => {
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hello', 1),
      mkOtherOp('Td', 2),
      mkTjOp('World', 3),
      mkOtherOp('ET', 4),
    ];

    const block1 = mkBlock(
      [mkChar('H', 1), mkChar('e', 1), mkChar('l', 1), mkChar('l', 1), mkChar('o', 1)],
      'Hi',
    );
    const block2 = mkBlock(
      [mkChar('W', 3), mkChar('o', 3), mkChar('r', 3), mkChar('l', 3), mkChar('d', 3)],
      'Earth',
    );

    const result = rebuildTextOperators(operators, [block1, block2]);

    // Both operators modified independently
    expect(result[1]!.modified).toBe(true);
    expect(result[3]!.modified).toBe(true);

    const op1 = result[1]!.operands[0]!;
    if (op1.type === PDFObjectType.String) expect(op1.value).toBe('Hi');

    const op3 = result[3]!.operands[0]!;
    if (op3.type === PDFObjectType.String) expect(op3.value).toBe('Earth');

    // Non-text operators untouched
    expect(result[0]!.modified).toBe(false);
    expect(result[2]!.modified).toBe(false);
    expect(result[4]!.modified).toBe(false);
  });

  it('merged block: all text goes to first operator, rest emptied', () => {
    // Simulates a merged block spanning operators 1 and 3
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hello', 1),
      mkOtherOp('Td', 2),
      mkTjOp('World', 3),
      mkOtherOp('ET', 4),
    ];
    // Merged block contains chars from both operators
    const chars = [
      mkChar('H', 1), mkChar('e', 1), mkChar('l', 1),
      mkChar('l', 1), mkChar('o', 1),
      mkChar('W', 3), mkChar('o', 3), mkChar('r', 3),
      mkChar('l', 3), mkChar('d', 3),
    ];
    const block = mkBlock(chars, 'Hi Earth');

    const result = rebuildTextOperators(operators, [block]);

    // First operator gets all the text
    expect(result[1]!.modified).toBe(true);
    const op1 = result[1]!.operands[0]!;
    if (op1.type === PDFObjectType.String) {
      expect(op1.value).toBe('Hi Earth');
    }

    // Second operator is emptied
    expect(result[3]!.modified).toBe(true);
    const op3 = result[3]!.operands[0]!;
    if (op3.type === PDFObjectType.String) {
      expect(op3.value).toBe('');
    }

    // Non-text operators untouched
    expect(result[0]!.modified).toBe(false);
    expect(result[2]!.modified).toBe(false);
    expect(result[4]!.modified).toBe(false);
  });

  it('serializeOperators round-trips unmodified operators verbatim', () => {
    const operators: ContentOperator[] = [
      mkOtherOp('BT', 0),
      mkTjOp('Hello', 1),
      mkOtherOp('ET', 2),
    ];

    const result = serializeOperators(operators);
    const text = new TextDecoder().decode(result);

    expect(text).toContain('BT');
    expect(text).toContain('(Hello) Tj');
    expect(text).toContain('ET');
  });
});
