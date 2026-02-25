import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

async function createTempRunDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'job-harvester-e2e-'));
}

describe('pipeline stage handoff e2e', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    jest.resetModules();
  });

  afterAll(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('runs 04-prefilter main against 03-fetch-specs output shape', async () => {
    const runDir = await createTempRunDir();
    tempDirs.push(runDir);

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

    const module = await import('../prefilter');
    await module.main(runDir);

    const survivorsContent = await fs.readFile(path.join(runDir, 'pre-filter-survivors.json'), 'utf-8');
    const survivors = JSON.parse(survivorsContent) as Array<{ id: string }>;

    expect(Array.isArray(survivors)).toBe(true);
    expect(survivors[0]?.id).toBe('job-1');
  });

  it('preserves spec text through compile and writes upload results at run root', async () => {
    const runDir = await createTempRunDir();
    tempDirs.push(runDir);

    await fs.mkdir(path.join(runDir, 'job-scores'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'pdfs'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'specs'), { recursive: true });
    await fs.mkdir(path.join(runDir, 'run-summary'), { recursive: true });

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

    // Create discovered-jobs.json so upload's recordProcessedUrlsForRun doesn't ENOENT
    await fs.writeFile(
      path.join(runDir, 'discovered-jobs.json'),
      JSON.stringify({ jobs: survivors }),
      'utf-8'
    );

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

    const compileModule = await import('../compile-results');
    await compileModule.main(runDir);

    const compileContent = await fs.readFile(path.join(runDir, 'compile-results.json'), 'utf-8');
    const compileJson = JSON.parse(compileContent) as {
      jobs: Array<{ company: string; specText: string }>;
    };
    const compiledJob = compileJson.jobs.find(job => job.company === 'Compile Company E2E');
    expect(compiledJob?.specText).toContain('must survive compile');

    const uploadModule = await import('../upload');
    await uploadModule.main(runDir);

    const uploadResultsPath = path.join(runDir, 'upload-results.json');
    const uploadResults = await fs.readFile(uploadResultsPath, 'utf-8');
    expect(uploadResults).toContain('"stats"');
  }, 15_000);
});
