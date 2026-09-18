import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next only ships classic (.eslintrc-style) configs, not
// flat-config-native ones — FlatCompat is the standard bridge (what
// `create-next-app` itself generates), not the `defineConfig`/
// `globalIgnores` helpers from "eslint/config". Those only exist in
// ESLint 9+, and this project pins eslint@^8.
const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
];

export default eslintConfig;
