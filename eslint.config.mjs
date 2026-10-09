import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const repositoryComments = {
  rules: {
    "english-comments": {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          language: "Write comments in English.",
          unfinished: "Remove unfinished development notes.",
        },
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              if (/[А-Яа-яЁё]/u.test(comment.value))
                context.report({ loc: comment.loc, messageId: "language" });
              if (/\b(?:TODO|FIXME|HACK|XXX)\b/.test(comment.value))
                context.report({ loc: comment.loc, messageId: "unfinished" });
            }
          },
        };
      },
    },
  },
};

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/.venv/**",
      "**/dist/**",
      "dist-cjs/**",
      "coverage/**",
      "**/vendor/**",
      "server/go/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts}"],
    plugins: { repository: repositoryComments },
    rules: { "repository/english-comments": "error" },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      "prefer-const": ["error", { ignoreReadBeforeAssign: true }],
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["**/*.{ts,tsx,mts}"],
    extends: [tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    files: [
      "src/**/*.ts",
      "packages/*/src/**/*.{ts,tsx}",
      "apps/*/src/**/*.{ts,tsx}",
      "web/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    files: ["packages/{compat,lo,telegram,telegram-to-lo,vk}/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "process",
        "Buffer",
        "require",
        "__dirname",
        "__filename",
      ],
    },
  },
);
