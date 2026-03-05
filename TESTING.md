# Building and Testing

## Build

```bash
# Install dependencies
npm install

# Install Playwright browser (required for PDF generation and web scraping)
npx playwright install chromium

# Compile TypeScript to dist/
npm run build
```

## Test

Tests use Jest with `ts-jest`. All tests are in `src/__tests__/`, one file per pipeline stage. Tests mock `fs/promises` and external APIs to run without network access or file I/O.

```bash
# Run all tests
npm test

# Run a single test file
npx jest src/__tests__/prefilter.test.ts

# Watch mode
npm run test:watch

# Coverage report
npm run test:coverage

# CI mode (4 GB heap, sequential execution)
npm run test:ci
```

## Lint

```bash
# Check for lint errors
npm run lint

# Auto-fix lint errors
npm run lint:fix
```

## Type Check

```bash
npm run check-types
```

## Full Validation

Runs type check, lint, and tests in sequence. Use this before committing:

```bash
npm run validate
```

## CI Pipeline

GitHub Actions runs on every push and PR:

```
npm ci → check-types → lint → test:ci
```
