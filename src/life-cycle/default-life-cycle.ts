import type {ProcessingLifeCycle} from './types.js';
import {skipLinks} from './skip-links.js';
import {detectResourceType} from './detect-resource-type.js';
import {createResource} from '../resource.js';
import {downloadResource} from './download-resource.js';
import {processHtml} from './process-html.js';
import {processHtmlMetaRefresh} from './process-html-meta.js';
import {processCss} from './process-css.js';
import {processSiteMap} from './process-site-map.js';
import {processSvg} from './process-svg.js';
import {saveHtmlToDisk} from './save-html-to-disk.js';
import {saveResourceToDisk} from './save-resource-to-disk.js';
import {processRedirectedUrl} from './adapters.js';
import {downloadStreamingResource} from './download-streaming-resource.js';
import {readOrCopyLocalResource} from './read-or-copy-local-resource.js';

/**
 * Get a copy of default life cycle
 */
export const defaultLifeCycle = (): ProcessingLifeCycle => ({
  init: [],
  linkRedirect: [skipLinks],
  detectResourceType: [detectResourceType],
  createResource,
  processBeforeDownload: [],
  download: [
    downloadResource,
    downloadStreamingResource,
    readOrCopyLocalResource
  ],
  processAfterDownload: [
    processRedirectedUrl,
    processHtml,
    processHtmlMetaRefresh,
    processSvg,
    processCss,
    processSiteMap
  ],
  saveToDisk: [saveHtmlToDisk, saveResourceToDisk],
  dispose: []
});

