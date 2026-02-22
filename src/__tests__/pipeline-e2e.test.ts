import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function createTempRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'job-harvester-e2e-'));
}

describe('pipeline stage handoff e2e', () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it('runs 03-prefilter main against 02-fetch-specs output shape', async () => {
    const runDir = await createTempRunDir();
    process.env.JOB_HARVESTER_DATA_DIR = runDir;

    const fetchedSpecs = {
      specs: [
        {
          id: 'job-1',
          company: 'Unique Company E2E',
          title: 'Senior Platform Architect',
          url: 'https://example.com/jobs/1',
          source: 'web',
          discoveredAt: '2026-01-01T00:00:00.000Z',
          specText: 'Spec content',
          fetchStatus: 'success',
          fetchError: undefined,
          fetchedAt: '2026-01-01T00:00:01.000Z',
        },
      ],
      timestamp: '2026-01-01T00:00:01.000Z',
      stats: { total: 1, success: 1, failed: 0 },
    };

    await fs.writeFile(path.join(runDir, 'fetched-specs.json'), JSON.stringify(fetchedSpecs), 'utf-8');

    const module = await import('../03-prefilter');
    await module.main();

    const survivorsContent = await fs.readFile(path.join(runDir, 'pre-filter-survivors.json'), 'utf-8');
    const survivors = JSON.parse(survivorsContent) as Array<{ id: string }>;

    expect(Array.isArray(survivors)).toBe(true);
    expect(survivors[0]?.id).toBe('job-1');
  });

  it('preserves spec text through compile and writes upload results at run root', async () => {
    const runDir = await createTempRunDir();
    process.env.JOB_HARVESTER_DATA_DIR = runDir;

    await fs.mkdir(path.join(runDir, 'job-scores'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'pdfs'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'specs'), { recursive: true });

    const survivors = [
      {
        id: 'job-2',
        company: 'Compile Company E2E',
        title: 'Principal Architect',
        url: 'https://example.com/jobs/2',
        source: 'web',
        discoveredAt: '2026-01-01T00:00:00.000Z',
        specText: 'This spec text must survive compile',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2026-01-01T00:00:01.000Z',
      },
    ];

    await fs.writeFile(path.join(runDir, 'pre-filter-survivors.json'), JSON.stringify(survivors), 'utf-8');
    await fs.writeFile(path.join(runDir, 'pre-filter-rejections.json'), JSON.stringify([]), 'utf-8');

    const today = new Date().toISOString().split('T')[0];
    await fs.writeFile(
      path.join(runDir, 'job-scores', `${today}-compile-company-e2e.json`),
      JSON.stringify({
        jobId: 'job-2',
        company: 'Compile Company E2E',
        title: 'Principal Architect',
        url: 'https://example.com/jobs/2',
        score: 8,
        reasoning: 'Strong fit',
        scoredAt: '2026-01-01T00:00:02.000Z',
      }),
      'utf-8'
    );

    const compileModule = await import('../04-compile-results');
    await compileModule.main();

    const compileContent = await fs.readFile(path.join(runDir, 'compile-results.json'), 'utf-8');
    const compileJson = JSON.parse(compileContent) as {
      jobs: Array<{ company: string; specText: string }>;
    };
    const compiledJob = compileJson.jobs.find(job => job.company === 'Compile Company E2E');
    expect(compiledJob?.specText).toContain('must survive compile');

    const uploadModule = await import('../06-upload');
    await uploadModule.main();

    const uploadResultsPath = path.join(runDir, 'upload-results.json');
    const uploadResults = await fs.readFile(uploadResultsPath, 'utf-8');
    expect(uploadResults).toContain('"stats"');
  });
});
