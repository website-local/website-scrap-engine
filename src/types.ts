import type cheerio from 'cheerio';

// adapters for making cheerio's namespace type definitions to module
export type CheerioStatic = cheerio.Root;
export type Cheerio = cheerio.Cheerio;
export type CheerioOptionsInterface = cheerio.CheerioParserOptions;
