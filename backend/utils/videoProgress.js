const jobs = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;

const prune = () => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - (job.updatedAt || 0) > MAX_AGE_MS) jobs.delete(id);
  }
};

export const createVideoJob = (jobId) => {
  prune();
  jobs.set(jobId, {
    progress: 1,
    stage: "script",
    label: "Starting…",
    status: "running",
    updatedAt: Date.now(),
  });
};

export const updateVideoJob = (jobId, patch) => {
  if (!jobId) return;
  const cur = jobs.get(jobId) || {
    progress: 0,
    stage: "script",
    label: "",
    status: "running",
  };
  jobs.set(jobId, {
    ...cur,
    ...patch,
    progress: Math.min(100, Math.max(0, Number(patch.progress ?? cur.progress) || 0)),
    updatedAt: Date.now(),
  });
};

export const getVideoJob = (jobId) => {
  prune();
  return jobs.get(jobId) || null;
};
