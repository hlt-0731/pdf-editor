/**
 * L1 Object Layer — Object Resolver
 *
 * Resolves indirect references (PDFRef) to their actual objects using the
 * cross-reference table (XRefTable) and a ByteStreamReader over the full PDF
 * file buffer.
 *
 * Features:
 *   - In-memory cache keyed by "objNum/genNum"
 *   - Circular reference detection via a resolving-set
 *   - Support for compressed object streams (XRefEntry.compressed === true)
 *   - Page tree traversal (/Type /Pages → /Kids → /Type /Page)
 *   - Content stream decoding and concatenation
 */

import { ByteStreamReader } from '../binary/reader.ts';
import { decodeStream } from '../binary/stream.ts';
import type { XRefTable, XRefEntry } from '../binary/xref.ts';
import { PDFParser } from './parser.ts';
import {
  type PDFObject,
  type PDFRef,
  type PDFDictionary,
  type PDFStream,
  PDF_NULL,
  isRef,
  isDict,
  isArray,
  isStream,
  isNumber,
  isName,
  getNumber,
  createRef,
} from './types.ts';

// ---------------------------------------------------------------------------
// Internal helper: extract filter names from a stream dictionary
// ---------------------------------------------------------------------------

/** Return the list of filter names from a stream dictionary's /Filter entry. */
function getFilterNames(stream: PDFStream): string[] {
  const filterEntry = stream.dict.get('Filter');
  if (filterEntry === undefined) return [];

  if (isName(filterEntry)) {
    return [filterEntry.value];
  }
  if (isArray(filterEntry)) {
    const names: string[] = [];
    for (const item of filterEntry.items) {
      if (isName(item)) names.push(item.value);
    }
    return names;
  }
  return [];
}

/** Decode a PDFStream by reading its filter chain from its dictionary. */
function decodeStreamObj(stream: PDFStream): Uint8Array {
  if (stream._decodedData !== undefined) {
    return stream._decodedData;
  }
  const filters = getFilterNames(stream);
  const result = filters.length > 0
    ? decodeStream(stream.rawData, filters)
    : stream.rawData;
  stream._decodedData = result;
  return result;
}

// ---------------------------------------------------------------------------
// ObjectResolver
// ---------------------------------------------------------------------------

export class ObjectResolver {
  /** Cache: "objNum/genNum" → resolved object */
  private readonly cache: Map<string, PDFObject>;

  /** Set of cache keys currently being resolved (for circular ref detection) */
  private readonly resolving: Set<string>;

  private readonly reader: ByteStreamReader;
  private readonly xref: XRefTable;

  constructor(reader: ByteStreamReader, xref: XRefTable) {
    this.reader = reader;
    this.xref = xref;
    this.cache = new Map();
    this.resolving = new Set();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolve an indirect reference to its actual object.
   * Returns PDF_NULL for unknown/free objects.
   * Throws on circular references.
   */
  resolve(ref: PDFRef): PDFObject {
    const key = cacheKey(ref.objNum, ref.genNum);

    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    if (this.resolving.has(key)) {
      throw new Error(
        `ObjectResolver.resolve: circular reference detected for object ${ref.objNum} ${ref.genNum} R`,
      );
    }

    const entry = this.xref.entries.get(ref.objNum);
    if (entry === undefined || !entry.inUse) {
      // Undefined or free object — return null per PDF spec §7.3.9
      return PDF_NULL;
    }

    this.resolving.add(key);
    let obj: PDFObject;

    try {
      if (entry.compressed === true) {
        obj = this.resolveFromObjectStream(entry);
      } else {
        const parser = new PDFParser(new ByteStreamReader(this.reader.buffer));
        const result = parser.parseObjectAt(entry.offset);
        obj = result.obj;
      }
    } finally {
      this.resolving.delete(key);
    }

    this.cache.set(key, obj);
    return obj;
  }

  /**
   * Resolve `obj` if it is a PDFRef; otherwise return it as-is.
   * Useful for traversing dictionary values that may be either inline or indirect.
   */
  resolveIfRef(obj: PDFObject): PDFObject {
    if (isRef(obj)) {
      return this.resolve(obj);
    }
    return obj;
  }

  /**
   * Return all page dictionaries in document order by traversing the page tree
   * starting from the document catalog's /Pages entry.
   */
  getPages(): PDFDictionary[] {
    const catalog = this.getCatalog();
    const pagesRef = catalog.getRequired('Pages');
    const pagesNode = this.resolveIfRef(pagesRef);

    if (!isDict(pagesNode)) {
      throw new Error('ObjectResolver.getPages: /Pages is not a dictionary');
    }

    const pages: PDFDictionary[] = [];
    this.traversePageTree(pagesNode, pages);
    return pages;
  }

  /**
   * Return the document catalog dictionary (/Type /Catalog).
   * Located via the XRef trailer's /Root indirect reference.
   */
  getCatalog(): PDFDictionary {
    const rootRef = this.xref.trailer.root;
    const rootObj = createRef(rootRef.objNum, rootRef.genNum);
    const catalog = this.resolveIfRef(rootObj);

    if (!isDict(catalog)) {
      throw new Error('ObjectResolver.getCatalog: /Root does not resolve to a dictionary');
    }

    return catalog;
  }

  /**
   * Return the decoded content stream bytes for a page dictionary.
   *
   * A page's /Contents may be:
   *   - absent (no content) → empty Uint8Array
   *   - a single indirect reference to a stream
   *   - an array of indirect references to streams
   *
   * Multiple streams are decoded individually and concatenated with a single
   * space (0x20) separator so operators at a stream boundary remain valid.
   */
  getPageContentStream(page: PDFDictionary): Uint8Array {
    const contentsEntry = page.get('Contents');
    if (contentsEntry === undefined) {
      return new Uint8Array(0);
    }

    const contents = this.resolveIfRef(contentsEntry);

    if (isArray(contents)) {
      const parts: Uint8Array[] = [];
      const spaceByte = new Uint8Array([0x20]);

      for (let i = 0; i < contents.items.length; i++) {
        const item = contents.items[i];
        if (item === undefined) continue;
        const resolved = this.resolveIfRef(item);
        if (!isStream(resolved)) {
          throw new Error(
            `ObjectResolver.getPageContentStream: /Contents array item ${i} is not a stream`,
          );
        }
        if (i > 0) parts.push(spaceByte);
        parts.push(decodeStreamObj(resolved));
      }

      return concatUint8Arrays(parts);
    }

    if (isStream(contents)) {
      return decodeStreamObj(contents);
    }

    throw new Error(
      'ObjectResolver.getPageContentStream: /Contents is neither a stream nor an array',
    );
  }

  /**
   * Return the resource dictionary for a page.
   * Resources may be inherited from ancestor nodes in the page tree.
   */
  getPageResources(page: PDFDictionary): PDFDictionary {
    const resourcesEntry = page.get('Resources');
    if (resourcesEntry !== undefined) {
      const resources = this.resolveIfRef(resourcesEntry);
      if (!isDict(resources)) {
        throw new Error('ObjectResolver.getPageResources: /Resources is not a dictionary');
      }
      return resources;
    }

    // Inherit from parent
    const parentEntry = page.get('Parent');
    if (parentEntry !== undefined) {
      const parent = this.resolveIfRef(parentEntry);
      if (isDict(parent)) {
        return this.getPageResources(parent);
      }
    }

    throw new Error(
      'ObjectResolver.getPageResources: /Resources not found in page or its ancestors',
    );
  }

  /** Clear the object cache (e.g. after incremental updates to the document). */
  clearCache(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve an object that lives inside a compressed object stream.
   *
   * Object stream format (PDF 32000-1:2008 §7.5.7):
   *   - /N      — number of objects stored in the stream
   *   - /First  — byte offset within the decoded stream of the first object body
   *   - Header  — N pairs of (objectNumber  byteOffset) at the start of decoded data
   *   - Body    — the N objects, accessed by jumping to /First + each entry's offset
   */
  private resolveFromObjectStream(entry: XRefEntry): PDFObject {
    if (entry.streamObjNum === undefined) {
      throw new Error(
        'ObjectResolver.resolveFromObjectStream: XRefEntry is compressed but has no streamObjNum',
      );
    }
    if (entry.indexInStream === undefined) {
      throw new Error(
        'ObjectResolver.resolveFromObjectStream: XRefEntry is compressed but has no indexInStream',
      );
    }

    const streamRef = createRef(entry.streamObjNum, 0);
    const streamObj = this.resolve(streamRef);

    if (!isStream(streamObj)) {
      throw new Error(
        `ObjectResolver.resolveFromObjectStream: object ${entry.streamObjNum} is not a stream`,
      );
    }

    const decoded = decodeStreamObj(streamObj);
    const streamParser = new PDFParser(new ByteStreamReader(decoded));

    const nObj = streamObj.dict.get('N');
    const firstObj = streamObj.dict.get('First');

    const n = getNumber(nObj);
    const first = getNumber(firstObj);

    if (n === undefined || first === undefined) {
      throw new Error(
        'ObjectResolver.resolveFromObjectStream: object stream missing /N or /First',
      );
    }

    // Read the N pairs of (objNum offset) from the stream header
    const indexEntries: Array<{ objNum: number; offset: number }> = [];
    for (let i = 0; i < n; i++) {
      const objNumObj = streamParser.parseObject();
      const offsetObj = streamParser.parseObject();

      if (!isNumber(objNumObj) || !isNumber(offsetObj)) {
        throw new Error(
          `ObjectResolver.resolveFromObjectStream: invalid index entry ${i} in object stream`,
        );
      }
      indexEntries.push({ objNum: objNumObj.value, offset: offsetObj.value });
    }

    const targetIndex = entry.indexInStream;
    if (targetIndex < 0 || targetIndex >= indexEntries.length) {
      throw new Error(
        `ObjectResolver.resolveFromObjectStream: index ${targetIndex} out of range ` +
        `(stream has ${indexEntries.length} objects)`,
      );
    }

    const indexEntry = indexEntries[targetIndex];
    if (indexEntry === undefined) {
      throw new Error(
        `ObjectResolver.resolveFromObjectStream: index entry ${targetIndex} is undefined`,
      );
    }

    streamParser.reader.seek(first + indexEntry.offset);
    return streamParser.parseObject();
  }

  /**
   * Recursively traverse the PDF page tree.
   *
   * @param node   The current page tree node dictionary.
   * @param pages  Accumulator for leaf /Type /Page dictionaries.
   */
  private traversePageTree(node: PDFDictionary, pages: PDFDictionary[]): void {
    const typeEntry = node.get('Type');
    const typeName = isName(typeEntry ?? PDF_NULL) ? (typeEntry as { value: string }).value : undefined;

    if (typeName === 'Page') {
      pages.push(node);
      return;
    }

    if (typeName !== 'Pages') {
      // Unknown node type — skip silently
      return;
    }

    const kidsEntry = node.get('Kids');
    if (kidsEntry === undefined) return;

    const kids = this.resolveIfRef(kidsEntry);
    if (!isArray(kids)) {
      throw new Error('ObjectResolver.traversePageTree: /Kids is not an array');
    }

    for (const kid of kids.items) {
      const kidResolved = this.resolveIfRef(kid);
      if (!isDict(kidResolved)) {
        throw new Error('ObjectResolver.traversePageTree: /Kids item is not a dictionary');
      }
      this.traversePageTree(kidResolved, pages);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-local utilities
// ---------------------------------------------------------------------------

function cacheKey(objNum: number, genNum: number): string {
  return `${objNum}/${genNum}`;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// Re-export PDFStream type for consumers that import from this module
export type { PDFStream };
