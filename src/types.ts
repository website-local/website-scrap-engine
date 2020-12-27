import type cheerio from 'cheerio';

// adapters for making cheerio's namespace type definitions to module
export type CheerioStatic = ReturnType<typeof cheerio.load>;
export type Cheerio = ReturnType<CheerioStatic['root']>;
export type CheerioOptionsInterface = NonNullable<Parameters<typeof cheerio.load>[1]>;
export type CheerioElement = Cheerio[number];
