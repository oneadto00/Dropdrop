import tseslint from "typescript-eslint";
import { parse } from "vue/compiler-sfc";

const packageBoundary = {
  regex: String.raw`^(\.\./)+(packages/)?(core|server|storage)/src/(?!index(\.js)?$)`,
  message: "跨包导入请使用对应的 src/index 入口",
};
const restricted = (...additional) => [
  "error",
  { patterns: [packageBoundary, ...additional] },
];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["apps/**", "packages/**"],
    rules: { "no-restricted-imports": restricted() },
  },
  {
    files: ["apps/web/**"],
    rules: {
      "no-restricted-imports": restricted({ regex: "(server|storage)/src/" }),
    },
  },
  {
    files: ["packages/core/**"],
    rules: { "no-restricted-imports": restricted({ regex: "^node:" }) },
  },
  {
    files: ["apps/web/**/*.vue"],
    processor: {
      preprocess(source) {
        const { descriptor } = parse(source);
        return [descriptor.script, descriptor.scriptSetup]
          .filter(Boolean)
          .map(
            (block) => "\n".repeat(block.loc.start.line - 1) + block.content,
          );
      },
      postprocess: (blocks) => blocks.flat(),
    },
    languageOptions: { parser: tseslint.parser },
    // Vue 模板也会引用脚本绑定。
    rules: { "@typescript-eslint/no-unused-vars": "off" },
  },
);
