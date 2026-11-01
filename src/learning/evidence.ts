import type { IngestStorage } from '../observability/storage.js';
import { computeDigest } from '../observability/digest.js';
import { runDetectors } from './detectors.js';
import { projectIdForPath, projectIdForTrace } from './scope.js';
import type { ReviewContext, ReviewEvidence } from './review.js';

// Rebuild detector evidence from stored traces, not lesson claims or stale
// digest aggregates. Missing/corrupt/misaddressed traces cannot validate a rule.
export async function loadReviewContext(storage: IngestStorage, targetRoot: string): Promise<ReviewContext> {
  const evidence: ReviewEvidence[] = [];
  for (const digest of await storage.listDigests()) {
    const trace = await storage.loadTrace(digest.sessionId);
    if (!trace || trace.sessionId !== digest.sessionId) continue;
    const candidates = runDetectors({ trace, digest: computeDigest(trace) });
    const candidateEvidence = new Map<string, Set<number>>();
    for (const candidate of candidates) {
      const seqs = candidateEvidence.get(candidate.candidateKey) ?? new Set<number>();
      for (const ref of candidate.evidence) if (ref.seq !== undefined) seqs.add(ref.seq);
      candidateEvidence.set(candidate.candidateKey, seqs);
    }
    evidence.push({
      sessionId: trace.sessionId,
      projectId: projectIdForTrace(trace),
      agentCli: trace.agentCli.name,
      observedAt: trace.endedAt ?? trace.startedAt,
      candidateKeys: new Set(candidates.map((candidate) => candidate.candidateKey)),
      eventSeqs: new Set(trace.events.map((event) => event.seq)),
      candidateEvidence,
    });
  }
  return { projectId: projectIdForPath(targetRoot), evidence };
}
