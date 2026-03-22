(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }

  root.PochoclaChunkProcessor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createSerialProcessor(processItem, hooks = {}) {
    const queue = [];
    let processing = false;
    const idleResolvers = [];

    function resolveIdle() {
      if (processing || queue.length > 0) return;
      while (idleResolvers.length > 0) {
        const resolve = idleResolvers.shift();
        resolve();
      }
      if (typeof hooks.onIdle === 'function') {
        hooks.onIdle();
      }
    }

    async function run() {
      if (processing) return;
      processing = true;

      while (queue.length > 0) {
        const item = queue.shift();
        try {
          await processItem(item);
        } catch (error) {
          if (typeof hooks.onError === 'function') {
            hooks.onError(error, item);
          }
        }
      }

      processing = false;
      resolveIdle();
    }

    return {
      enqueue(item) {
        queue.push(item);
        void run();
      },
      isProcessing() {
        return processing;
      },
      size() {
        return queue.length;
      },
      waitForIdle() {
        if (!processing && queue.length === 0) {
          return Promise.resolve();
        }

        return new Promise((resolve) => {
          idleResolvers.push(resolve);
        });
      }
    };
  }

  return {
    createSerialProcessor
  };
});
