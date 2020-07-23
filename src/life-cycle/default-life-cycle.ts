import {ProcessingLifeCycle} from './types';
import {skipLinks} from './skip-links';
import {detectResourceType} from './detect-resource-type';
import {createResource} from '../resource';
import {downloadResource} from './download-resource';
import {processHtml} from './process-html';
import {processCss} from './process-css';
import {processSiteMap} from './process-site-map';
import {processSvg} from './process-svg';
import {saveHtmlToDisk} from './save-html-to-disk';
import {saveResourceToDisk} from './save-resource-to-disk';
import {processRedirectedUrl} from './adapters';

/**
 * Get a copy of default life cycle
 */
export const defaultLifeCycle = (): ProcessingLifeCycle => ({
  linkRedirect: [skipLinks],
  detectResourceType: [detectResourceType],
  createResource,
  processBeforeDownload: [],
  download: [downloadResource],
  processAfterDownload: [
    processRedirectedUrl,
    processHtml,
    processSvg,
    processCss,
    processSiteMap
  ],
  saveToDisk: [saveHtmlToDisk, saveResourceToDisk]
});

