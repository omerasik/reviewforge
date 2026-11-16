import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default [
  { ignores: ["**/dist/**", "data/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended
];
