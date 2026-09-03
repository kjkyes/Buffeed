const mapPrototype = Map.prototype as Map<unknown, unknown> & {
  getOrInsertComputed?: (key: unknown, callback: () => unknown) => unknown;
};

if (!mapPrototype.getOrInsertComputed) {
  Object.defineProperty(mapPrototype, "getOrInsertComputed", {
    configurable: true,
    value(this: Map<unknown, unknown>, key: unknown, callback: () => unknown) {
      if (!this.has(key)) this.set(key, callback());
      return this.get(key);
    },
  });
}

await import("pdfjs-dist/build/pdf.worker.mjs");

export {};
