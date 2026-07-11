/** Simple async mutex — one Facebook/Instagram browser at a time. */
export const createMutex = () => {
  let locked = false;
  const queue = [];

  const acquire = () =>
    new Promise((resolve) => {
      if (!locked) {
        locked = true;
        resolve();
        return;
      }
      queue.push(resolve);
    });

  const release = () => {
    const next = queue.shift();
    if (next) next();
    else locked = false;
  };

  const run = async (fn) => {
    await acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  };

  return { run };
};
