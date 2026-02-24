# Testing Guide

## Overview

This project uses Jest for testing with full TypeScript support. All tests are located in `src/__tests__/`.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Test Structure

Each script has a corresponding test file:

- `02-extract-from-emails.ts` → `02-extract-from-emails.test.ts`
- `03-fetch-specs.ts` → `03-fetch-specs.test.ts`
- `04-prefilter.ts` → `04-prefilter.test.ts`
- `05-score-survivors.ts` → `05-score-survivors.test.ts`
- `06-compile-results.ts` → `06-compile-results.test.ts`
- `07-generate-pdfs.ts` → `07-generate-pdfs.test.ts`
- `08-summarize-run.ts` → `08-summarize-run.test.ts`
- `09-upload.ts` → `09-upload.test.ts`

## Mocking Strategy

### File System

Tests mock `fs/promises` to avoid actual file operations:

```typescript
jest.mock('fs/promises');
const mockedFs = fs as jest.Mocked<typeof fs>;
```

### External APIs

External APIs (Gmail, Brightdata, OneDrive, Google Drive) should be mocked in their respective test files.

## Writing Tests

### Unit Tests

Test individual functions in isolation:

```typescript
describe('functionName', () => {
  it('should do something', () => {
    const result = functionName(input);
    expect(result).toBe(expected);
  });
});
```

### Integration Tests

Test the interaction between multiple functions:

```typescript
describe('runPreFilter', () => {
  it('should separate survivors and rejections', async () => {
    mockedFs.readFile.mockResolvedValueOnce('Google\nMicrosoft');
    mockedFs.readFile.mockResolvedValueOnce('[]');
    
    const result = await runPreFilter(specs);
    
    expect(result.survivors).toHaveLength(1);
    expect(result.rejections).toHaveLength(1);
  });
});
```

## Coverage Requirements

- All exported functions should have tests
- All filter conditions should be tested
- All error paths should be tested
- Aim for >80% code coverage

## Test Data

Use realistic test data that matches the actual data structures:

```typescript
const jobSpec: JobSpec = {
  id: '1',
  company: 'Google',
  title: 'Senior Developer',
  url: 'https://example.com/job',
  source: 'linkedin',
  discoveredAt: '2024-01-01',
  specText: '',
  fetchStatus: 'success',
  fetchedAt: '2024-01-01',
};
```

## Continuous Integration

Tests should pass before merging:

```bash
npm run lint && npm run check-types && npm run build && npm run test:ci
```
