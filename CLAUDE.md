# CLAUDE.md — sls-2-cdk

## Project Overview

CLI tool that converts Serverless Framework projects into AWS CDK-ready artifacts. It extracts CloudFormation templates, substitutes variables, and builds Lambda environment variable maps for CDK migration.

**Package name**: `sls-2-cdk`
**CLI command**: `sls-2-cdk migrate [OPTIONS]`

## Tech Stack

- **Language**: TypeScript 5 (strict mode, ES2024 target, ESM)
- **Runtime**: Node.js >= 22.0.0
- **CLI Framework**: oclif v4
- **Package Manager**: pnpm (workspace-enabled)
- **Testing**: Vitest 3 (globals enabled)
- **Linting/Formatting**: ESLint 9 (flat config) + Prettier 3, using @aligent/ts-code-standards

## Common Commands

```bash
pnpm run build            # Clean dist/ and compile TypeScript
pnpm run test             # Run tests (also runs lint via posttest hook)
pnpm run test:watch       # Watch mode
pnpm run test:coverage    # Coverage report
pnpm run lint             # ESLint
pnpm run dev              # Build + run dev CLI
```

## Project Structure

```
src/
├── commands/migrate.ts    # Main oclif command (entry point for CLI logic)
├── steps/                 # Processing pipeline steps
│   ├── substitute-variables.ts
│   ├── package.ts
│   └── build-env-map.ts
├── types/index.ts         # All TypeScript type definitions
├── utils/file-io.ts       # File I/O utilities
└── index.ts               # oclif run export
test/
├── steps/                 # Unit tests for each step
└── fixtures/              # Test fixture files (YAML, JSON)
bin/
├── run.js                 # Production entry point
└── dev.js                 # Development entry point (tsx)
```

## Coding Conventions

- **Classes**: PascalCase; **Functions**: camelCase; **Constants**: UPPER_SNAKE_CASE
- **Indentation**: 4 spaces (2 for YAML/JSON/Markdown)
- **Line length**: 100 characters max
- **Line endings**: LF, with final newline
- Each step module exports focused pure functions
- Step outputs are wrapped in `StepOutput<T>` with timing/error tracking

### TypeScript conventions

- **ESM imports** with `.js` extensions: `import { foo } from './bar.js'`
- **Node builtins** use `node:` prefix: `import * as fs from 'node:fs'`
- **Type-only imports**: `import type { Foo } from '../types/index.js'`
- **File names**: kebab-case (`build-env-map.ts`)
- Strict mode everywhere, no `any` escape hatches
- Prefer `satisfies` over `as` for type narrowing
- Barrel exports only at package boundaries, not within packages
- Types are centralized in `src/types/index.ts`
- CDK constructs use interface props, not inline objects

## Testing

- Tests live in `test/steps/` mirroring `src/steps/`
- Fixtures in `test/fixtures/`
- Uses `describe`/`it` blocks with Vitest globals (no imports needed)
- Factory helpers for test data (e.g., `makeLambdaTemplate()`)
- Test-specific tsconfig: `tsconfig.test.json` (no emit, includes both src/ and test/)

## Key Dependencies

- `@oclif/core` — CLI framework (commands, flags, parsing)
- `@inquirer/prompts` — Interactive CLI prompts
- `yaml` — YAML parsing with document visitor pattern
- `@aligent/ts-code-standards` — Shared ESLint/Prettier/TS configs
