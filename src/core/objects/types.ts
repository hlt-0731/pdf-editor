/**
 * L1 Object Layer — PDF object type definitions.
 *
 * Covers all nine PDF object types defined in PDF 32000-1:2008 §7.3,
 * plus the indirect-reference pseudo-type used by the parser/resolver,
 * and a content-stream-only inline image variant.
 *
 * NOTE: `erasableSyntaxOnly: true` in tsconfig forbids both `enum` and
 * `const enum`.  The discriminant values are implemented as a plain
 * `as const` object; the union type `PDFObjectType` is derived from it.
 */

// ---------------------------------------------------------------------------
// Discriminant "enum" — implemented as an erasable const object
// ---------------------------------------------------------------------------

export const PDFObjectType = {
  Null:       'null',
  Boolean:    'boolean',
  Number:     'number',
  String:     'string',
  HexString:  'hexstring',
  Name:       'name',
  Array:      'array',
  Dictionary: 'dictionary',
  Stream:     'stream',
  Ref:        'ref',
} as const;

/** Union of all PDFObjectType values (the discriminant). */
export type PDFObjectType = typeof PDFObjectType[keyof typeof PDFObjectType];

// ---------------------------------------------------------------------------
// Object interfaces
// ---------------------------------------------------------------------------

export interface PDFNull {
  type: typeof PDFObjectType.Null;
}

export interface PDFBoolean {
  type: typeof PDFObjectType.Boolean;
  value: boolean;
}

export interface PDFNumber {
  type: typeof PDFObjectType.Number;
  value: number;
}

/**
 * Literal string `(...)`.
 * `value` is the decoded string (escape sequences resolved, octal converted).
 * `raw` preserves the original bytes for callers that need the exact byte
 * content (e.g. encryption layers).
 */
export interface PDFString {
  type: typeof PDFObjectType.String;
  value: string;
  raw: Uint8Array;
}

/**
 * Hex string `<...>`.
 * `value` is the decoded string (hex pairs converted to characters).
 * `raw` is the original hex-digit sequence (without angle brackets).
 */
export interface PDFHexString {
  type: typeof PDFObjectType.HexString;
  value: string;
  raw: string;
}

/** PDF name object, e.g. /Font. The leading `/` is NOT stored in `value`. */
export interface PDFName {
  type: typeof PDFObjectType.Name;
  /** Name value without the leading `/`, with `#xx` escapes resolved. */
  value: string;
}

export interface PDFArray {
  type: typeof PDFObjectType.Array;
  items: PDFObject[];
}

export interface PDFDictionary {
  type: typeof PDFObjectType.Dictionary;
  /** Key is the name string without the leading slash. */
  entries: Map<string, PDFObject>;
  /** Return the value for `key`, or undefined if absent. */
  get(key: string): PDFObject | undefined;
  /** Return the value for `key`; throw a descriptive error if absent. */
  getRequired(key: string): PDFObject;
  /** Return true if `key` is present in this dictionary. */
  has(key: string): boolean;
}

export interface PDFStream {
  type: typeof PDFObjectType.Stream;
  dict: PDFDictionary;
  /** Raw (possibly compressed / filtered) stream bytes. */
  rawData: Uint8Array;
  /** Decoded bytes, lazily populated by decodeStream(). */
  _decodedData?: Uint8Array;
}

/** Indirect reference — `N G R` in PDF syntax. */
export interface PDFRef {
  type: typeof PDFObjectType.Ref;
  objNum: number;
  genNum: number;
}

/**
 * Inline image token produced by the `BI…ID…EI` construct inside a content
 * stream.  Not a standard PDF object type, but carried as a PDFObject variant
 * so the content-stream tokenizer can return it uniformly with other objects.
 */
export interface PDFInlineImage {
  type: 'inline_image';
  dict: PDFDictionary;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Union type
// ---------------------------------------------------------------------------

export type PDFObject =
  | PDFNull
  | PDFBoolean
  | PDFNumber
  | PDFString
  | PDFHexString
  | PDFName
  | PDFArray
  | PDFDictionary
  | PDFStream
  | PDFRef
  | PDFInlineImage;

// ---------------------------------------------------------------------------
// Singleton constant
// ---------------------------------------------------------------------------

/** Singleton null object — there is only ever one null value. */
export const PDF_NULL: PDFNull = { type: PDFObjectType.Null };

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

/**
 * Create a PDFDictionary with proper get / has / getRequired implementations.
 *
 * @param entries Optional initial key–value pairs (key is name without `/`).
 */
export function createDict(entries?: [string, PDFObject][]): PDFDictionary {
  const map = new Map<string, PDFObject>(entries);

  const dict: PDFDictionary = {
    type: PDFObjectType.Dictionary,
    entries: map,
    get(key: string): PDFObject | undefined {
      return map.get(key);
    },
    getRequired(key: string): PDFObject {
      const value = map.get(key);
      if (value === undefined) {
        throw new Error(`PDFDictionary: required key "/${key}" is missing`);
      }
      return value;
    },
    has(key: string): boolean {
      return map.has(key);
    },
  };

  return dict;
}

export function createRef(objNum: number, genNum: number): PDFRef {
  return { type: PDFObjectType.Ref, objNum, genNum };
}

export function createName(value: string): PDFName {
  return { type: PDFObjectType.Name, value };
}

export function createNumber(value: number): PDFNumber {
  return { type: PDFObjectType.Number, value };
}

export function createString(value: string): PDFString {
  const encoder = new TextEncoder();
  return {
    type: PDFObjectType.String,
    value,
    raw: encoder.encode(value),
  };
}

export function createArray(items: PDFObject[]): PDFArray {
  return { type: PDFObjectType.Array, items };
}

export function createInlineImage(dict: PDFDictionary, data: Uint8Array): PDFInlineImage {
  return { type: 'inline_image', dict, data };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isRef(obj: PDFObject): obj is PDFRef {
  return obj.type === PDFObjectType.Ref;
}

export function isDict(obj: PDFObject): obj is PDFDictionary {
  return obj.type === PDFObjectType.Dictionary;
}

export function isName(obj: PDFObject): obj is PDFName {
  return obj.type === PDFObjectType.Name;
}

export function isNumber(obj: PDFObject): obj is PDFNumber {
  return obj.type === PDFObjectType.Number;
}

export function isString(obj: PDFObject): obj is PDFString {
  return obj.type === PDFObjectType.String;
}

export function isArray(obj: PDFObject): obj is PDFArray {
  return obj.type === PDFObjectType.Array;
}

export function isStream(obj: PDFObject): obj is PDFStream {
  return obj.type === PDFObjectType.Stream;
}

// ---------------------------------------------------------------------------
// Value extractors
// ---------------------------------------------------------------------------

/** Extract the name string from a PDFName, or undefined for any other type. */
export function getName(obj: PDFObject | undefined): string | undefined {
  if (obj === undefined) return undefined;
  return isName(obj) ? obj.value : undefined;
}

/** Extract the numeric value from a PDFNumber, or undefined for any other type. */
export function getNumber(obj: PDFObject | undefined): number | undefined {
  if (obj === undefined) return undefined;
  return isNumber(obj) ? obj.value : undefined;
}
