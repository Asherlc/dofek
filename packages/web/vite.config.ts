import { defineConfig } from "vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [
    tanstackRouter({
      routesDirectory: "./routes",
      generatedRouteTree: "./routeTree.gen.ts",
    }),
    react(),
    tailwindcss(),
  ],
  root: "src",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ["echarts", "echarts-for-react"],
          react: ["react", "react-dom"],
          trpc: ["@trpc/client", "@trpc/react-query", "@tanstack/react-query"],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/auth": "http://localhost:3000",
      "/callback": "http://localhost:3000",
    },
  },
});
