/**
 * Shared TypeScript types for job-harvester pipeline
 * Based on plans/job-search-pipeline/types.md
 */

// ============================================================================
// Discovery Phase Types (discover.ts)
// ============================================================================

export interface DiscoveredJob {
  id: string;
  company: string;
  title: string;
  url: string;
  source: 'gmail' | 'linkedin' | 'brave' | 'brave-extracted';
  discoveredAt: string;
}

export interface DiscoveryOutput {
  jobs: DiscoveredJob[];
  timestamp: string;
  stats: {
    total: number;
    bySource: Record<string, number>;
  };
}

// ============================================================================
// Fetch Specs Phase Types (fetch-specs.ts)
// ============================================================================

export interface JobSpec {
  id: string;
  company: string;
  title: string;
  url: string;
  source: string;
  discoveredAt: string;
  specText: string;
  fetchStatus: 'success' | 'failed';
  fetchError: string | undefined;
  fetchedAt: string;
}

export interface FetchOutput {
  specs: JobSpec[];
  timestamp: string;
  stats: {
    total: number;
    success: number;
    failed: number;
  };
}

// ============================================================================
// Pre-filter Phase Types (prefilter.ts)
// ============================================================================

export type RejectionReason =
  | 'fetch_failed'
  | 'already_applied'
  | 'already_sent'
  | 'junior_role';

export interface FilterVerdict {
  jobId: string;
  company: string;
  title: string;
  url: string;
  passed: boolean;
  rejectionReason: RejectionReason | undefined;
  checkedAt: string;
}

export interface PreFilterOutput {
  survivors: JobSpec[];
  rejections: FilterVerdict[];
  timestamp: string;
  stats: {
    total: number;
    survivors: number;
    rejections: number;
    byReason: Record<RejectionReason, number>;
  };
}

// ============================================================================
// AI Scoring Types (AI step between prefilter and compile)
// ============================================================================

export interface JobScore {
  jobId: string;
  company: string;
  title: string;
  url: string;
  score: number;
  reasoning: string;
  scoredAt: string;
}

export interface ScoringOutput {
  scores: JobScore[];
  timestamp: string;
  stats: {
    total: number;
    averageScore: number;
  };
}

// ============================================================================
// Compile Results Phase Types (compile-results.ts)
// ============================================================================

export interface CompiledJob {
  jobId: string;
  company: string;
  title: string;
  url: string;
  specText: string;
  score: number;
  reasoning: string;
  passedPreFilter: boolean;
  rejectionReason: RejectionReason | undefined;
  status: 'scored' | 'rejected_prefilter';
  compiledAt: string;
}

export interface CompileOutput {
  jobs: CompiledJob[];
  timestamp: string;
  stats: {
    total: number;
    scored: number;
    rejectedPreFilter: number;
  };
}

// ============================================================================
// PDF Generation Types (generate-pdfs.ts)
// ============================================================================

export interface PDFResult {
  jobId: string;
  company: string;
  title: string;
  pdfPath: string;
  generatedAt: string;
}

export interface PDFOutput {
  pdfs: PDFResult[];
  timestamp: string;
  stats: {
    total: number;
    success: number;
    failed: number;
  };
}

// ============================================================================
// Run Summary Types (summarize-run.ts)
// ============================================================================

export interface RunSummaryOutput {
  timestamp: string;
  runDir: string;
  summaryLogFile: string;
  reviewJobsMdFile: string;
  reviewJobsCsvFile: string;
  metadataFile: string;
  aiUsed: boolean;
}

// ============================================================================
// Upload Types (upload.ts)
// ============================================================================

export interface UploadResult {
  jobId: string;
  company: string;
  title: string;
  pdfPath: string;
  oneDriveUrl: string | undefined;
  googleDriveUrl: string | undefined;
  uploadedAt: string;
}

export interface UploadOutput {
  uploads: UploadResult[];
  timestamp: string;
  archiveFolderName?: string;
  googleDriveFolderId?: string;
  stats: {
    total: number;
    success: number;
    failed: number;
  };
}

// ============================================================================
// Orchestrator Types (run-job-search.ts)
// ============================================================================

export type PipelinePhase = 'discover' | 'fetch' | 'prefilter' | 'score' | 'compile' | 'pdfs' | 'upload' | 'full';

export interface PipelineConfig {
  phase: PipelinePhase;
  dataDir: string;
  skipUpload?: boolean;
}

export interface PipelineResult {
  success: boolean;
  phase: PipelinePhase;
  durationMs: number;
  error?: string;
}
