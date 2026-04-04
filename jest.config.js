// jest.config.ts
import {createDefaultEsmPreset} from 'ts-jest';

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  ...createDefaultEsmPreset({
    tsconfig: {
      rootDir: '.',
    },
    diagnostics: {
      ignoreCodes: [151002]
    }
  }),
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
