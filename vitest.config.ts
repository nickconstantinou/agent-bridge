import { defineConfig } from "vitest/config";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";

export default defineConfig({
  plugins: [
    {
      name: "prefer-ts-over-js",
      enforce: "pre",
      resolveId(id, importer) {
        if (!id.endsWith(".js") || !importer) return;
        const tsPath = resolve(dirname(importer), id.replace(/\.js$/, ".ts"));
        if (existsSync(tsPath)) return tsPath;
      },
    },
  ],
});
