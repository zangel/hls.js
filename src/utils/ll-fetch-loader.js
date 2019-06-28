const { Request, Headers, fetch, performance } = window;

export default class LLFetchLoader {
  constructor (config) {
    this.fetchSetup = config.fetchSetup;
  }

  destroy () {
    this.abort();
    this.abortControler = null;
  }

  abort () {
    let abortControler = this.abortControler;
    if (abortControler) {
      abortControler.abort();
    }
  }

  load (context, config, callbacks) {
    let stats = {
      trequest: performance.now(),
      retry: 0
    };

    let targetURL = context.url;
    let request;
    this.abortControler = new AbortController();
    let abortSignal = this.abortControler.signal;

    const initParams = {
      method: 'GET',
      mode: 'cors',
      credentials: 'same-origin',
      signal: abortSignal
    };

    const headersObj = {};

    if (context.rangeEnd) {
      headersObj['Range'] = 'bytes=' + context.rangeStart + '-' + String(context.rangeEnd - 1);
    } /* jshint ignore:line */

    initParams.headers = new Headers(headersObj);

    if (this.fetchSetup) {
      request = this.fetchSetup(context, initParams);
    } else {
      request = new Request(context.url, initParams);
    }

    if (context.progressData) {
      fetch(request, initParams).then(function (response) {
        if (response.ok) {
          stats.tfirst = Math.max(stats.trequest, performance.now());
          stats.loaded = 0;
          targetURL = response.url;
          let reader = response.body.getReader();
          return reader.read().then(function process (result) {
            if (result.done) {
              stats.tload = Math.max(stats.tfirst, performance.now());
              stats.total = stats.loaded;
              let response = { url: targetURL };
              callbacks.onSuccess(response, stats, context);
              return;
            }

            stats.loaded += result.value.length;
            callbacks.onProgress(stats, context, result.value);

            return reader.read().then(process);
          });
        } else {
          callbacks.onError({ text: 'fetch, bad network response' }, context);
        }
      }).catch(function (error) {
        callbacks.onError({ text: error.message }, context);
      });
    } else {
      fetch(request, initParams).then(function (response) {
        if (response.ok) {
          stats.tfirst = Math.max(stats.trequest, performance.now());
          targetURL = response.url;
          if (context.responseType === 'arraybuffer') {
            return response.arrayBuffer();
          } else {
            return response.text();
          }
        } else {
          callbacks.onError({ text: 'fetch, bad network response' }, context);
        }
      }).then(function (responseData) {
        if (responseData) {
          stats.tload = Math.max(stats.tfirst, performance.now());
          let len;
          if (typeof responseData === 'string') {
            len = responseData.length;
          } else {
            len = responseData.byteLength;
          }

          stats.loaded = stats.total = len;
          let response = { url: targetURL, data: responseData };
          callbacks.onSuccess(response, stats, context);
        }
      }).catch(function (error) {
        callbacks.onError({ text: error.message }, context);
      });
    }
  }
}
