// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/*.config.*', '**/.claude/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // §16.7 — no `any` without a `// reason:` comment is enforced by review;
  // the linter forbids implicit/explicit any so the reviewer only sees justified ones.
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off', // enabled in typed configs per-workspace
    },
  },

  // §16.1 FENCE 1 — the PWA must never import daemon internals.
  {
    files: ['pwa/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['**/daemon/**', '../daemon/*', '../../daemon/*'],
          message: 'The PWA must not import daemon internals. Cross the boundary over HTTP/WS only.',
        }],
      }],
    },
  },

  // Service worker runs in the ServiceWorkerGlobalScope — teach ESLint its globals.
  {
    files: ['pwa/public/**/*.js'],
    languageOptions: {
      globals: { self: 'readonly', clients: 'readonly', caches: 'readonly', fetch: 'readonly' },
    },
  },

  // §16.1 FENCE 2 — only lib/claude-adapter may touch Claude Code internals.
  // Enforced on the string paths themselves, since these are filesystem/socket paths, not imports.
  {
    files: ['daemon/src/**/*.ts'],
    ignores: ['daemon/src/lib/claude-adapter/**'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "Literal[value=/\\.claude\\/(sessions|projects)/]",
          message: 'Only lib/claude-adapter may reference ~/.claude paths (§16.1 quarantine).',
        },
        {
          selector: "Literal[value=/cc-socks/]",
          message: 'Only lib/claude-adapter may reference the peer socket path (§16.1 quarantine).',
        },
      ],
    },
  },

  // §16.1 FENCE 2, second half — `docs/`. `eslint .` already lints TypeScript
  // under `docs/`, so the quarantine can be enforced there by the linter rather
  // than by a reviewer remembering §6's carve-out paragraph. Same two selectors
  // as the daemon half above; the ONE written §6 carve-out is named here as an
  // explicit exemption, which turns "enforced by review against a paragraph"
  // into "lint-enforced except one named path". A second diagnostic that wants
  // this exemption has to be added here and to §6 — deliberately, not silently.
  {
    files: ['docs/**/*.ts'],
    ignores: ['docs/features/askuserquestion-answer-mechanism/stories/story-3-manual-test.ts'],
    rules: {
      'no-restricted-syntax': ['error',
        {
          selector: "Literal[value=/\\.claude\\/(sessions|projects)/]",
          message: 'Only lib/claude-adapter may reference ~/.claude paths (§16.1 quarantine). A docs/ diagnostic needs the §6 carve-out and an entry in this rule\'s ignores.',
        },
        {
          selector: "Literal[value=/cc-socks/]",
          message: 'Only lib/claude-adapter may reference the peer socket path (§16.1 quarantine).',
        },
      ],
    },
  },
);
