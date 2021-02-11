import {
  createResource,
  CreateResourceArgument,
  Resource,
  ResourceBody,
  ResourceEncoding,
  ResourceType
} from '../../src/resource';
import type {DownloadResource} from '../../src/life-cycle/types';
import type {StaticDownloadOptions} from '../../src/options';
// noinspection ES6PreferShortImport
import type {PipelineExecutor} from '../../src/life-cycle/pipeline-executor';

export const fakeOpt = {
  concurrency: 0,
  encoding: {},
  localRoot: 'root',
  maxDepth: 0,
  meta: {}
} as StaticDownloadOptions;

export const fakePipeline = {
  createResource(
    type: ResourceType,
    depth: number,
    url: string,
    refUrl: string,
    localRoot?: string,
    encoding?: ResourceEncoding,
    refSavePath?: string,
    refType?: ResourceType
  ): Resource {
    const arg: CreateResourceArgument = {
      type,
      depth,
      url,
      refUrl,
      refSavePath,
      refType,
      localRoot: localRoot ?? 'root',
      encoding: encoding ?? 'utf8',
    };
    return createResource(arg);
  }

} as PipelineExecutor;

export const res = (
  url: string,
  body: ResourceBody,
  refUrl?: string,
  refSavePath?: string
): DownloadResource => {
  const resource = fakePipeline.createResource(
    ResourceType.Binary, 1, url, refUrl ?? url,
    undefined, undefined, refSavePath
  ) as Resource;
  resource.body = body;
  return resource as DownloadResource;
};

export const resHtml = (
  url: string,
  body: ResourceBody,
  refUrl?: string,
  refSavePath?: string
): DownloadResource => {
  const resource = fakePipeline.createResource(
    ResourceType.Html, 1, url, refUrl ?? url,
    undefined, undefined, refSavePath
  ) as Resource;
  resource.body = body;
  return resource as DownloadResource;
};
