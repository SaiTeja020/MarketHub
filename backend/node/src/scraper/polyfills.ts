// src/scraper/polyfills.ts
// Must be imported before any module that may require 'undici' or other WebFetch shims.
// Adds a minimal File global so libraries that reference File at import-time do not crash.

if (typeof (globalThis as any).File === "undefined") {
    // Use Node's Buffer Blob if available
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Blob: BufferBlob } = require("buffer");
  
    // Minimal File polyfill compatible with common usages:
    // new File([...], name, { type, lastModified })
    (globalThis as any).File = class File extends (globalThis.Blob || BufferBlob) {
      name: string;
      lastModified: number;
      webkitRelativePath = "";
  
      constructor(chunks: any[] = [], filename: string = "file", options: any = {}) {
        // Blob constructor accepts (parts, options)
        // @ts-ignore - BufferBlob / Blob constructor
        super(chunks as any, options);
        this.name = filename;
        this.lastModified = options?.lastModified ?? Date.now();
      }
    };
  }
  