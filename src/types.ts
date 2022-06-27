import type {load} from 'cheerio';

// adapters for making cheerio's namespace type definitions to module
export type CheerioStatic = ReturnType<typeof load>;
export type Cheerio = ReturnType<CheerioStatic>;
export type CheerioOptionsInterface = NonNullable<Parameters<typeof load>[1]>;
export type CheerioElement = Cheerio[number];
