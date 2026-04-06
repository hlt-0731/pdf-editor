/**
 * Tests for PDF encryption key derivation and dictionary generation.
 */

import { describe, it, expect } from 'vitest';
import { buildEncryptDictionary } from './encrypt';

describe('buildEncryptDictionary', () => {
  it('produces a valid /Encrypt dictionary with required fields', () => {
    const fileId = new Uint8Array(16);
    fileId.fill(0xab);

    const result = buildEncryptDictionary('test', '', undefined, fileId);
    const dict = new TextDecoder().decode(result.encryptDictBytes);

    expect(dict).toContain('/Type /Encrypt');
    expect(dict).toContain('/Filter /Standard');
    expect(dict).toContain('/V 2');
    expect(dict).toContain('/R 3');
    expect(dict).toContain('/Length 128');
    expect(dict).toContain('/O <');
    expect(dict).toContain('/U <');
    expect(dict).toContain('/P ');
  });

  it('returns 16-byte file ID', () => {
    const result = buildEncryptDictionary('hello', '');
    expect(result.fileId.length).toBe(16);
  });

  it('reuses existing file ID when provided', () => {
    const existingId = new Uint8Array(16);
    existingId.fill(0x42);

    const result = buildEncryptDictionary('pwd', '', undefined, existingId);
    expect(result.fileId).toEqual(existingId);
  });

  it('produces different O/U values for different passwords', () => {
    const fileId = new Uint8Array(16);
    fileId.fill(0x01);

    const r1 = buildEncryptDictionary('password1', '', undefined, fileId);
    const r2 = buildEncryptDictionary('password2', '', undefined, fileId);

    const d1 = new TextDecoder().decode(r1.encryptDictBytes);
    const d2 = new TextDecoder().decode(r2.encryptDictBytes);

    // Extract /O values
    const o1 = d1.match(/\/O <([0-9a-f]+)>/)?.[1];
    const o2 = d2.match(/\/O <([0-9a-f]+)>/)?.[1];
    expect(o1).not.toBe(o2);
  });

  it('O value is 32 bytes (64 hex chars)', () => {
    const result = buildEncryptDictionary('test', 'owner');
    const dict = new TextDecoder().decode(result.encryptDictBytes);
    const oMatch = dict.match(/\/O <([0-9a-f]+)>/);
    expect(oMatch).not.toBeNull();
    expect(oMatch![1]!.length).toBe(64); // 32 bytes = 64 hex
  });

  it('U value is 32 bytes (64 hex chars)', () => {
    const result = buildEncryptDictionary('test', 'owner');
    const dict = new TextDecoder().decode(result.encryptDictBytes);
    const uMatch = dict.match(/\/U <([0-9a-f]+)>/);
    expect(uMatch).not.toBeNull();
    expect(uMatch![1]!.length).toBe(64); // 32 bytes = 64 hex
  });
});
