import LLStreamController from './ll-stream-controller';

export default class LLPlaylistLoader {
  constructor(config, controller) {
    this.controller = controller;
  }

  destroy() {
    this.abort();
  }

  abort() {
    if (!this.stats.aborted) {
      this.controller.abortLoadLevel(this);
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

    if (context.type === "manifest") {
      if (controller.isStarted())
        controller.stop();

      controller.start(context.url);

      if (controller.isStarted()) {
        controller.loadLevel(this);
      } else {
        callbacks.onError({ text: "LLStreamController is not started!" }, context);
        return;
      }
    } else if (context.type === "level") {
      if (controller.isStarted()) {
        controller.loadLevel(this);
      }
      else {
        callbacks.onError({ text: "LLStreamController is not started!" }, context);
        return;
      }
    }
  }

  onSuccess(playlist) {
    let stats = this.stats, context = this.context;
    stats.tfirst = stats.tload = performance.now();
    stats.loaded = stats.total = playlist.length;
    let response = { url: context.url, data: playlist };
    this.callbacks.onSuccess(response, stats, context);
  }

  onProgress(playlist) {
    let stats = this.stats, context = this.context;
    stats.loaded = playlist.length;
    if (this.callbacks.onProgress) {
      this.callbacks.onProgress(stats, context);
    }
  }

  onTimeout() {
    this.callbacks.onTimeout(this.stats, this.context, null);
  }
}
