import LLStreamController from './ll-stream-controller';

export default class LLFragmentLoader {
  constructor(config, controller) {
    this.controller = controller;
  }

  destroy() {
    this.abort();
  }

  abort() {
    if (!this.stats.aborted) {
      this.controller.abortLoadFragment(this);
      this.stats.aborted = true;
    }
  }

  load(context, config, callbacks) {
    let controller = this.controller;
    this.context = context;
    this.config = config;
    this.callbacks = callbacks;
    this.stats = { trequest: performance.now(), retry: 0 };
    this.retryDelay = config.retryDelay;
    if (controller.isStarted()) {
      controller.loadFragment(this);
    } else {
      callbacks.onError({ text: "LLStreamController is not started!" }, context);
      return;
    }
  }

  onSuccess(data) {
    let stats = this.stats, context = this.context;
    stats.tfirst = stats.tload = performance.now();
    stats.loaded = stats.total = data.length;
    let response = { url: context.url, data: data };
    this.callbacks.onSuccess(response, stats, context);
  }

  onProgress(data) {
    let stats = this.stats, context = this.context;
    stats.loaded = data.length;
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(stats, context);
    }
  }

  onTimeout() {
    this.callbacks.onTimeout(this.stats, this.context, null);
  }
}
