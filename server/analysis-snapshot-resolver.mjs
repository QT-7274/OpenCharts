// crypto-ai-analysis.FORWARD_SIMULATION.10-1
// Order operations may resolve only the latest snapshot from durable analysis records.
export function resolveCurrentPersistedAnalysisAttempt(analysisPipeline, snapshotId) {
  if (typeof analysisPipeline?.getRecords !== "function") return null;
  const records = analysisPipeline.getRecords();
  if (!Array.isArray(records)) return null;
  const attempt = records.find((record) => record?.snapshotId === snapshotId) ?? null;
  if (!attempt || attempt.persistenceError) return null;
  const latest = [...records].reverse().find((record) => record?.symbol === attempt.symbol);
  return latest?.snapshotId === snapshotId ? attempt : null;
}
