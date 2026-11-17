import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        comments: { legal: true },
        postBanner: () =>
          "/*!\n" +
          readFileSync(
            new URL("../../node_modules/vue/LICENSE", import.meta.url),
            "utf8",
          ) +
          "\n" +
          readFileSync(
            new URL("../../node_modules/vite/LICENSE.md", import.meta.url),
            "utf8",
          ).split("# Licenses of bundled dependencies")[0] +
          "\n*/",
        entryFileNames: "assets/dropdrop.js",
        assetFileNames: "assets/dropdrop.[ext]",
      },
    },
  },
});
