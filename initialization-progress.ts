/** Progress describes one real stage, not an estimated percentage for the whole initialization. */
export interface AtlasInitializationProgress {
  readonly stage: string;
  readonly message: string;
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: string;
}
export type AtlasInitializationProgressCallback = (progress: AtlasInitializationProgress) => void | Promise<void>;

export async function reportAtlasInitializationProgress(callback: AtlasInitializationProgressCallback | undefined,
  progress: AtlasInitializationProgress, signal?: AbortSignal): Promise<void> {
  if (!callback || signal?.aborted) return;
  try { await callback(progress); } catch { /* Reporting must not change acquisition or publication. */ }
}
