import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function inlineMcpAppBundle(): Plugin {
  return {
    name: "inline-mcp-app-bundle",
    apply: "build",
    async closeBundle() {
      const outputDirectory = resolve(import.meta.dirname, "dist");
      const htmlPath = resolve(outputDirectory, "index.html");
      const html = await readFile(htmlPath, "utf8");
      const scriptSource = html.match(
        /<script type="module" crossorigin src="(\/assets\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)"><\/script>/,
      )?.[1];
      if (!scriptSource) throw new Error("MCP App bundle did not produce a safe module script path.");
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
