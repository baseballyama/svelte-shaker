import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it } from 'vitest';
import { svelteShaker } from '../src/index';

const resolve = (relative: string): Promise<string> => {
  const cwd = process.cwd();
  const absolute = path.resolve(cwd, relative);
  return Promise.resolve(absolute);
};

describe('svelte-shaker', () => {
  const dirs = fs
    .readdirSync('./tests/fixtures', { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => `${dirent.parentPath}/${dirent.name}`);

  for (const dir of dirs) {
    it(dir, async ({ expect }) => {
      let foundExpectedFiles = fs
        .readdirSync(`${dir}/expected`, { withFileTypes: true })
        .filter((dirent) => dirent.isFile())
        .map((dirent) => `${dirent.parentPath}/${dirent.name}`);

      const result = await svelteShaker(`${dir}/input/App.svelte`, resolve);

      console.log(result);

      for (const path of Object.keys(result)) {
        const content = result[path] ?? '';
        const actualPath = path.replace('/input/', '/actual/');
        fs.writeFileSync(actualPath, content);
        const expectedPath = path.replace('/input/', '/expect/');
        foundExpectedFiles = foundExpectedFiles.filter(
          (file) => file !== expectedPath,
        );
        const expected = fs.readFileSync(expectedPath, 'utf-8');
        expect(content).toBe(expected);
      }

      if (foundExpectedFiles.length !== 0) {
        expect.fail(
          `Expected files not found: ${foundExpectedFiles.join(', ')}`,
        );
      }
    });
  }
});
