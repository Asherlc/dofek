import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function inlineMcpAppBundle() {
  return {
    name: "inline-mcp-app-bundle",
    apply: "build" as const,
    async closeBundle() {
      const outputDirectory = resolve(import.meta.dirname, "dist");
      const htmlPath = resolve(outputDirectory, "index.html");
      const html = await readFile(htmlPath, "utf8");
      const scriptSource = html.match(/<script type="module" crossorigin src="([^"]+)"><\/script>/)?.[1];
      if (!scriptSource) throw new Error("MCP App bundle did not produce a module script.");
      const script = (await readFile(resolve(outputDirectory, scriptSource.slice(1)), "utf8")).replace(
        /<\/script/gi,
        "<\\/script",
      );
      await writeFile(
        htmlPath,
        html
          .replace(scriptSource, "")
          .replace(
            "<script type=\"module\" crossorigin src=\"\"></script>",
            () => `<script type="module">${script}</script>`,
          ),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), inlineMcpAppBundle()],
  build: {
    cssCodeSplit: false,
    rolldownOptions: {
      output: {
        codeSplitting: false,
      },
    },
  },
});
