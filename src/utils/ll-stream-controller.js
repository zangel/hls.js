import LLPlaylistLoader from './ll-playlist-loader';
import Fragment from '../loader/fragment'
import Level from '../loader/level';
import { Loader, PlaylistContextType, PlaylistLoaderContext, PlaylistLevelType, LoaderCallbacks, LoaderResponse, LoaderStats, LoaderConfiguration } from '../types/loader';
import XhrLoader from './xhr-loader';
import M3U8Parser from '../loader/m3u8-parser';
import LLFetchLoader from './ll-fetch-loader';
import { logger } from './logger';

export default class LLStreamController {
  constructor(config) {
    this.config = config;
    this.manifestLoader = null;
    this.levelLoader = null;
    this.fragmentLoader = null;
    this.level = null;
    this.currentFragment = null;
    this.bufferedDuration = 0.0;
    this.url = null;
    this.started = false;
    this.loadLevelRequest = null;
    this.loadFragmentRequest = null;

  }

  isStarted() {
    return this.started;
  }

  start(url) {
    if (this.started || this.manifestLoader)
      return;

    this.url = url;
    this.loadLevelRequest = null;
    this.loadFragmentRequest = null;

    this.manifestLoader = null;
    this.levelLoader = null;
    this.fragmentLoader = null;
    this.bufferedDuration = 0.0;

    this.downloadManifest();

    this.started = true;

    // to remove
    //setTimeout(this.stop.bind(this), 5000);
  }

  stop() {
    if (!this.started)
      return;

    if (this.manifestLoader) {
      this.manifestLoader.abort();
      this.manifestLoader = null;
    }

    if (this.levelLoader) {
      this.levelLoader.abort();
      this.levelLoader = null;
    }

    if (this.fragmentLoader) {
      this.fragmentLoader.abort();
      this.fragmentLoader = null;
    }

    if (this.loadLevelRequest) {
      this.loadLevelRequest.callbacks.onError({ text: "LLStreamController stopped!" }, this.loadLevelRequest.context);
      this.abortLoadLevel(this.loadLevelRequest);
    }

    if (this.loadFragmentRequest) {
      this.loadFragmentRequest.callbacks.onError({ text: "LLStreamController stopped!" }, this.loadFragmentRequest.context);
      this.abortLoadFragment(this.loadFragmentRequest);
    }

    this.level = null;
    this.currentFragment = null;

    this.started = false;

    // to remove
    /*
    var controller = this;
    setTimeout(function() {
        controller.start(controller.url)
    }, 2000);
    */
  }

  loadLevel(loader) {

    if (!this.started) {
      loader.callbacks.onError({ text: "LLStreamController not running!" }, loader.context);
      return;
    }

    if (this.loadLevelRequest) {
      this.loadLevelRequest.callbacks.onError({ text: "LLStreamController canceled!" }, this.loadLevelRequest.context);
      clearTimeout(this.loadLevelRequestTimeout);
      this.loadLevelRequestTimeout = null;
      this.loadLevelRequest = null;
    }

    this.loadLevelRequest = loader;
    this.loadLevelRequestTimeout = setTimeout(this.onLoadLevelRequestTimeout.bind(this), loader.config.timeout);

    setTimeout(this.onLoadLevelRequest.bind(this), 0);
  }

  abortLoadLevel(loader) {
    if (this.loadLevelRequest === loader) {
      clearTimeout(this.loadLevelRequestTimeout);
      this.loadLevelRequestTimeout = null;
      this.loadLevelRequest = null;
    }
  }

  loadFragment(loader) {

    if (!this.started) {
      loader.callbacks.onError({ text: "LLStreamController not running!" }, loader.context);
      return;
    }

    if (this.loadFragmentRequest) {
      this.loadFragmentRequest.callbacks.onError({ text: "LLStreamController canceled!" }, this.loadFragmentRequest.context);
      clearTimeout(this.loadFragmentRequestTimeout);
      this.loadFragmentRequestTimeout = null;
      this.loadFragmentRequest = null;
    }

    this.loadFragmentRequest = loader;
    this.loadFragmentRequestTimeout = setTimeout(this.onLoadFragmentRequestTimeout.bind(this), loader.config.timeout);

    setTimeout(this.onLoadFragmentRequest.bind(this), 0);
  }

  abortLoadFragment(loader) {
    if (this.loadFragmentRequest === loader) {
      clearTimeout(this.loadFragmentRequestTimeout);
      this.loadFragmentRequestTimeout = null;
      this.loadFragmentRequest = null;
    }
  }

  onLoadLevelRequest() {
    let loader = this.loadLevelRequest;

    if (!loader || !this.currentFragment || !this.currentFragment.currentVideoFrame)
      return;

    const virtualSegmentDuration = 1.0 / this.config.llFrameRate;
    const mediaSequence = this.makeVirtualMediaSequence(this.currentFragment, this.currentFragment.currentVideoFrame);

    let playlist = "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1.0\n";
    playlist += "#EXT-X-MEDIA-SEQUENCE:" + mediaSequence + "\n";

    for (let s = 0; s < 30; ++s) {
      playlist += "#EXTINF:" + virtualSegmentDuration + ",\n" + (mediaSequence + s) + ".ts\n"
    }

    clearTimeout(this.loadLevelRequestTimeout);
    this.loadLevelRequestTimeout = null;
    this.loadLevelRequest = null;

    loader.onProgress(playlist);
    loader.onSuccess(playlist);
  }

  onLoadFragmentRequest() {
    let loader = this.loadFragmentRequest;
    if (!loader)
      return;

    let virtualFragment = loader.context.frag;
    const framesPerSegment = this.config.llFrameRate * this.config.llSegmentDuration;
    const videoFrameIndex = virtualFragment.sn % framesPerSegment;
    const fragmentSN = (virtualFragment.sn - videoFrameIndex) / framesPerSegment;
    let fragment = this.level.fragments.find(function (f) { return fragmentSN == f.sn; });
    if (!fragment)
      return;

    if (!fragment.videoFrames)
      return;

    if (videoFrameIndex >= fragment.videoFrames.length)
      return;

    const videoFrame = fragment.videoFrames[videoFrameIndex];

    if (fragment === this.currentFragment && videoFrame === this.currentFragment.currentVideoFrame)
      return;

    let dataLength = (fragment.prefixPackets.length + 2 + videoFrame.packets.length) * 188;
    let data = new Uint8Array(dataLength);

    //prefix packets
    for (let i = 0; i < fragment.prefixPackets.length; ++i) {
      data.set(
        fragment.rawData.subarray(fragment.prefixPackets[i], fragment.prefixPackets[i] + 188),
        i * 188
      );
    }

    //PAT packet
    data.set(
      fragment.rawData.subarray(fragment.patStart, fragment.patStart + 188),
      fragment.prefixPackets.length * 188
    );

    //PMT packet
    data.set(
      fragment.rawData.subarray(fragment.pmtStart, fragment.pmtStart + 188),
      (fragment.prefixPackets.length + 1) * 188
    );

    //frame packets
    for (let i = 0; i < videoFrame.packets.length; ++i) {
      data.set(
        fragment.rawData.subarray(videoFrame.packets[i], videoFrame.packets[i] + 188),
        (fragment.prefixPackets.length + 2 + i) * 188
      );
    }

    clearTimeout(this.loadFragmentRequestTimeout);
    this.loadFragmentRequestTimeout = null;
    this.loadFragmentRequest = null;

    loader.onProgress(data);
    loader.onSuccess(data);
  }

  onLoadLevelRequestTimeout() {
    if (!this.loadLevelRequest)
      return;

    this.loadLevelRequest.onTimeout();
    this.loadLevelRequest = null;
    this.loadLevelRequestTimeout = null;
  }

  onLoadFragmentRequestTimeout() {
    if (!this.loadFragmentRequest)
      return;

    this.loadFragmentRequest.onTimeout();
    this.loadFragmentRequest = null;
    this.loadFragmentRequestTimeout = null;
  }

  onNewVideoFrame() {
    try {
      this.onLoadFragmentRequest();
    } catch (error) {
      logger.error("onLoadFragmentRequest :" + error);
    }

    try {
      this.onLoadLevelRequest();
    } catch (error) {
      logger.error("onLoadLevelRequest :" + error);
    }
  }

  makeVirtualMediaSequence(fragment, videoFrame) {
    const framesPerSegment = this.config.llFrameRate * this.config.llSegmentDuration;
    return fragment.sn * framesPerSegment + fragment.videoFrames.indexOf(videoFrame);
  }

  downloadManifest() {
    this.manifestLoader = new XhrLoader(this.config);

    const loaderContext = {
      url: this.url,
      loader: this.manifestLoader,
      type: PlaylistContextType.MANIFEST,
      level: 0,
      id: null,
      responseType: 'text'
    };

    const loaderConfig = {
      maxRetry: this.config.manifestLoadingMaxRetry,
      timeout: this.config.manifestLoadingTimeOut,
      retryDelay: this.config.manifestLoadingRetryDelay,
      maxRetryDelay: this.config.manifestLoadingMaxRetryTimeout
    };

    const loaderCallbacks = {
      onSuccess: this.onManifestLoaderSuccess.bind(this),
      onError: this.onManifestLoaderError.bind(this),
      onTimeout: this.onManifestLoaderTimeout.bind(this)
    };

    this.manifestLoader.load(loaderContext, loaderConfig, loaderCallbacks);
  }

  onManifestLoaderSuccess(response, stats, context, networkDetails) {
    if (typeof response.data !== 'string') {
      throw new Error('expected responseType of "text"');
    }

    stats.tload = performance.now();

    const { id, level, type } = context;
    const url = response.url;

    const levelUrlId = id ? id : 0;
    const levelId = level;

    const levelType = PlaylistLevelType.MAIN;
    this.level = M3U8Parser.parseLevelPlaylist(response.data, url, levelId, levelType, levelUrlId);

    let nextFragment = this.findNextFragmentToDownload();

    if (nextFragment) {
      this.downloadFragment(nextFragment);
    }

    this.manifestLoader = null;
  }

  onManifestLoaderError(response, context, networkDetails) {

  }

  onManifestLoaderTimeout(stats, context, networkDetails) {

  }

  downloadLevel() {
    this.levelLoader = new XhrLoader(this.config);

    const loaderContext = {
      url: this.url,
      loader: this.levelLoader,
      type: PlaylistContextType.LEVEL,
      level: 0,
      id: null,
      responseType: 'text'
    };

    const loaderConfig = {
      maxRetry: 0,
      timeout: this.config.levelLoadingTimeOut,
      retryDelay: 0,
      maxRetryDelay: 0
    };

    const loaderCallbacks = {
      onSuccess: this.onLevelLoaderSuccess.bind(this),
      onError: this.onLevelLoaderError.bind(this),
      onTimeout: this.onLevelLoaderTimeout.bind(this)
    };

    this.levelLoader.load(loaderContext, loaderConfig, loaderCallbacks);
  }

  onLevelLoaderSuccess(response, stats, context, networkDetails) {
    if (typeof response.data !== 'string') {
      throw new Error('expected responseType of "text"');
    }

    stats.tload = performance.now();

    const { id, level, type } = context;
    const url = response.url;

    const levelUrlId = id ? id : 0;
    const levelId = level;

    const levelType = PlaylistLevelType.MAIN;
    let newLevel = M3U8Parser.parseLevelPlaylist(response.data, url, levelId, levelType, levelUrlId);

    this.updateLevel(newLevel);
    this.levelLoader = null;
  }

  onLevelLoaderError(response, context, networkDetails) {
    this.levelLoader = null;
  }

  onLevelLoaderTimeout(stats, context, networkDetails) {
    this.levelLoader = null;
  }

  findNextFragmentToDownload() {
    if (this.level.fragments.length === 0)
      return null;

    if (this.currentFragment) {
      let currentFragmentIndex = this.level.fragments.indexOf(this.currentFragment);
      if (currentFragmentIndex < 0)
        return null;

      currentFragmentIndex++;

      if (currentFragmentIndex === this.level.fragments.length)
        return null;

      //if (this.level.fragments[currentFragmentIndex].sn !== this.currentFragment.sn + 1)
      //    return null;

      return this.level.fragments[currentFragmentIndex];
    }
    return this.level.fragments[0];
  }

  updateLevel(newLevel) {
    let controller = this;
    newLevel.fragments.forEach(function (fragment) {
      let fragmentIndex = controller.level.fragments.findIndex(function (f) { return fragment.sn == f.sn; });
      if (fragmentIndex < 0) {
        controller.level.fragments.push(fragment);
      }
    });
  }

  downloadFragment(fragment) {

    this.currentFragment = fragment;
    this.currentFragment.loaded = 0;
    this.currentFragment.pmtParsed = false;
    this.currentFragment.prefixPackets = [];
    this.currentFragment.rawData = new Uint8Array(0);
    this.currentFragment.videoFrames = [];

    this.fragmentLoader = new LLFetchLoader(this.config);

    const loaderContext = {
      url: fragment.url,
      loader: this.fragmentLoader,
      frag: fragment,
      responseType: 'arraybuffer',
      progressData: true
    };

    const loaderConfig = {
      timeout: this.config.fragLoadingTimeOut,
      maxRetry: 0,
      retryDelay: 0,
      maxRetryDelay: this.config.fragLoadingMaxRetryTimeout
    };

    const loaderCallbacks = {
      onSuccess: this.onFragmentLoaderSuccess.bind(this),
      onError: this.onFragmentLoaderError.bind(this),
      onTimeout: this.onFragmentLoaderTimeout.bind(this),
      onProgress: this.onFragmentLoaderProgress.bind(this)
    };

    this.fragmentLoader.load(loaderContext, loaderConfig, loaderCallbacks);
  }

  onFragmentLoaderSuccess(response, stats, context, networkDetails) {
    this.fragmentLoader = null;
    let fragment = context.frag;
    if (fragment === this.currentFragment) {
      this.bufferedDuration += fragment.duration;
      this.currentFragment.currentVideoFrame = null;
      let nextFragment = this.findNextFragmentToDownload();
      if (nextFragment) {
        this.downloadFragment(nextFragment);
      } else {
        logger.warn('could not find next fragment to download!');
      }

      if (fragment.videoFrames.length !== 30) {
        logger.warn(`fragment(${fragment.sn}) with ${fragment.videoFrames.length} video frames`);
      }
    } else {
      logger.warn('downloaded fragment(' + fragment.sn + ' != currentFragment(' + this.currentFragment.sn + ')');
    }

    while (this.bufferedDuration > 1.0 && this.level.fragments.length > 1 && this.currentFragment !== this.level.fragments[0]) {
      this.bufferedDuration -= this.level.fragments[0].duration;
      this.level.fragments.shift();
    }
    this.downloadLevel();
  }

  onFragmentLoaderError(response, context, networkDetails) {
    this.fragmentLoader = null;
    let fragment = context.frag;
    logger.warn('could not download fragment(' + fragment.sn + ')');
  }

  onFragmentLoaderTimeout(stats, context, networkDetails) {
    this.fragmentLoader = null;
    let fragment = context.frag;
    logger.warn('timeout downloading fragment(' + fragment.sn + ')');
  }

  onFragmentLoaderProgress(stats, context, data, networkDetails) {
    let fragment = context.frag;
    if (fragment === this.currentFragment) {
      let newData = new Uint8Array(data);
      let newRawData = new Uint8Array(this.currentFragment.rawData.byteLength + newData.byteLength);
      newRawData.set(this.currentFragment.rawData, 0);
      newRawData.set(newData, this.currentFragment.rawData.byteLength);

      const parseOffset = this.currentFragment.rawData.byteLength;
      this.currentFragment.rawData = newRawData;
      this.parseFragmentData(parseOffset);
      fragment.loaded = stats.loaded;
    } else {
      logger.warn('download progress fragment(' + fragment.sn + ' != currentFragment(' + this.currentFragment.sn + ')');
    }
  }

  parseFragmentData(parseOffset) {
    let data = this.currentFragment.rawData, len = data.length;

    parseOffset -= parseOffset % 188;
    len -= len % 188;
    for (let start = parseOffset; start < len; start += 188) {
      if (data[start] === 0x47) {

        let stt = !!(data[start + 1] & 0x40);
        let pid = ((data[start + 1] & 0x1f) << 8) + data[start + 2];
        let atf = (data[start + 3] & 0x30) >> 4;

        let offset;
        if (atf > 1) {
          offset = start + 5 + data[start + 4];

          if (offset === (start + 188)) {
            continue;
          }
        } else {
          offset = start + 4;
        }

        if (pid === 0) {

          this.currentFragment.patStart = start;

          if (stt) {
            offset += data[offset] + 1;
          }

          this.currentFragment.pmtId = this.parseFragmentPAT(data, offset);
          this.currentFragment.pmtParsed = true;

        } else if (pid === this.currentFragment.pmtId) {

          this.currentFragment.pmtStart = start;
          if (stt) {
            offset += data[offset] + 1;
          }

          let parsedPIDs = this.parseFragmentPMT(data, offset, true, false);

          this.currentFragment.avcId = parsedPIDs.avc;
          this.currentFragment.audioId = parsedPIDs.audio;
          this.currentFragment.id3Id = parsedPIDs.id3;

        } else if (pid === this.currentFragment.avcId) {
          if (stt) {
            let videoFrame = {
              packets: [start],
            };
            this.currentFragment.videoFrames.push(videoFrame);
            this.currentFragment.currentVideoFrame = videoFrame;
            this.onNewVideoFrame();

          } else {
            this.currentFragment.currentVideoFrame.packets.push(start);
          }

        } else if (pid === 17 || pid === 0x1fff) {
          if (!this.currentFragment.pmtParsed) {
            this.currentFragment.prefixPackets.push(start);
          }
        } else {
          logger.warn('unknown PID:' + pid);
        }
      } else {
        logger.warn('mpegts packet does not start with 0x47');
      }
    }
  }

  parseFragmentPAT(data, offset) {
    return (data[offset + 10] & 0x1F) << 8 | data[offset + 11];
  }

  parseFragmentPMT(data, offset, mpegSupported, isSampleAes) {
    let sectionLength, tableEnd, programInfoLength, pid, result = { audio: -1, avc: -1, id3: -1, isAAC: true };
    sectionLength = (data[offset + 1] & 0x0f) << 8 | data[offset + 2];
    tableEnd = offset + 3 + sectionLength - 4;

    // to determine where the table is, we have to figure out how
    // long the program info descriptors are
    programInfoLength = (data[offset + 10] & 0x0f) << 8 | data[offset + 11];

    // advance the offset to the first entry in the mapping table
    offset += 12 + programInfoLength;
    while (offset < tableEnd) {
      pid = (data[offset + 1] & 0x1F) << 8 | data[offset + 2];
      switch (data[offset]) {
        case 0xcf: // SAMPLE-AES AAC
          if (!isSampleAes) {
            logger.log('unkown stream type:' + data[offset]);
            break;
          }
        /* falls through */

        // ISO/IEC 13818-7 ADTS AAC (MPEG-2 lower bit-rate audio)
        case 0x0f:
          // logger.log('AAC PID:'  + pid);
          if (result.audio === -1) {
            result.audio = pid;
          }
          break;

        // Packetized metadata (ID3)
        case 0x15:
          // logger.log('ID3 PID:'  + pid);
          if (result.id3 === -1) {
            result.id3 = pid;
          }
          break;

        case 0xdb: // SAMPLE-AES AVC
          if (!isSampleAes) {
            logger.log('unkown stream type:' + data[offset]);
            break;
          }
        /* falls through */

        // ITU-T Rec. H.264 and ISO/IEC 14496-10 (lower bit-rate video)
        case 0x1b:
          // logger.log('AVC PID:'  + pid);
          if (result.avc === -1) {
            result.avc = pid;
          }
          break;

        // ISO/IEC 11172-3 (MPEG-1 audio)
        // or ISO/IEC 13818-3 (MPEG-2 halved sample rate audio)
        case 0x03:
        case 0x04:
          // logger.log('MPEG PID:'  + pid);
          if (!mpegSupported) {
            logger.log('MPEG audio found, not supported in this browser for now');
          } else if (result.audio === -1) {
            result.audio = pid;
            result.isAAC = false;
          }
          break;

        case 0x24:
          logger.warn('HEVC stream type found, not supported for now');
          break;

        default:
          logger.log('unkown stream type:' + data[offset]);
          break;
      }
      // move to the next table entry
      // skip past the elementary stream descriptors, if present
      offset += ((data[offset + 3] & 0x0F) << 8 | data[offset + 4]) + 5;
    }
    return result;
  }
};

