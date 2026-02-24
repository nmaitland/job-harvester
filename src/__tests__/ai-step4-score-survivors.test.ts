import * as fs from 'fs/promises';
import * as path from 'path';
import { runStep4 } from '../ai/step4-score-survivors';
import { requestOpenRouterChat } from '../ai/openrouter-client';

jest.mock('fs/promises');
jest.mock('../ai/openrouter-client', () => ({
  requestOpenRouterChat: jest.fn(),
}));

const mockedFs = fs as jest.Mocked<typeof fs>;
const mockedRequestOpenRouterChat = requestOpenRouterChat as jest.MockedFunction<typeof requestOpenRouterChat>;

describe('runStep4', () => {
  const runDir = '/tmp/run-123';
  const managementDir = '/tmp/management';

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JOB_HARVESTER_MANAGEMENT_DATA_DIR = managementDir;
    mockedFs.mkdir.mockResolvedValue(undefined);
    mockedFs.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete process.env.JOB_HARVESTER_MANAGEMENT_DATA_DIR;
  });

  it('writes one score file per survivor', async () => {
    const survivors = [
      {
        id: 'job-1',
        company: 'Acme',
        title: 'Head of Engineering',
        url: 'https://acme.example/jobs/1',
        source: 'linkedin',
        discoveredAt: '2026-02-23T00:00:00.000Z',
        specText: 'Cloud transformation and leadership role',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2026-02-23T00:01:00.000Z',
      },
      {
        id: 'job-2',
        company: 'Beta',
        title: 'CTO',
        url: 'https://beta.example/jobs/2',
        source: 'web',
        discoveredAt: '2026-02-23T00:00:00.000Z',
        specText: 'Architecture strategy role',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2026-02-23T00:01:00.000Z',
      },
    ];

    mockedFs.readFile
      .mockResolvedValueOnce(JSON.stringify(survivors))
      .mockResolvedValueOnce('# cv keywords\n- architecture\n- cloud\n');

    mockedRequestOpenRouterChat
      .mockResolvedValueOnce('{"score":8,"reasoning":"Great fit","verdict":"PASS"}')
      .mockResolvedValueOnce('{"score":5,"reasoning":"Borderline fit"}');

    const result = await runStep4(runDir);

    expect(result.total).toBe(2);
    expect(result.pass).toBe(1);
    expect(result.review).toBe(1);
    expect(result.reject).toBe(0);
    expect(result.files).toHaveLength(2);

    expect(mockedFs.mkdir).toHaveBeenCalledWith(path.join(runDir, 'job-scores'), { recursive: true });
    expect(mockedFs.writeFile).toHaveBeenCalledTimes(3);
  });

  it('writes fallback verdict when AI call fails', async () => {
    const survivors = [
      {
        id: 'job-fallback',
        company: 'Fallback Ltd',
        title: 'Director of Engineering',
        url: 'https://fallback.example/jobs/1',
        source: 'web',
        discoveredAt: '2026-02-23T00:00:00.000Z',
        specText: 'Role description',
        fetchStatus: 'success',
        fetchError: undefined,
        fetchedAt: '2026-02-23T00:01:00.000Z',
      },
    ];

    mockedFs.readFile
      .mockResolvedValueOnce(JSON.stringify(survivors))
      .mockResolvedValueOnce('# cv keywords');

    mockedRequestOpenRouterChat.mockRejectedValueOnce(new Error('network down'));

    const result = await runStep4(runDir);

    expect(result.total).toBe(1);
    expect(result.reject).toBe(1);

    const firstWritePayload = mockedFs.writeFile.mock.calls[0]?.[1] as string;
    const verdict = JSON.parse(firstWritePayload) as { score: number; verdict: string; reasoning: string };
    expect(verdict.score).toBe(3);
    expect(verdict.verdict).toBe('REJECT');
    expect(verdict.reasoning).toContain('Fallback verdict');
  });
});

