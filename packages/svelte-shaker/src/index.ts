import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse } from 'svelte/compiler';
import { svelteFiles } from './data';
import { phase1 } from './phase1';

const parseSvelteFile = (
  rootSvelteFilePath: string,
  resolve: (id: string) => Promise<string>,
) => {
  const entryFileContent = fs.readFileSync(rootSvelteFilePath, 'utf-8');
  svelteFiles.set(path.resolve(rootSvelteFilePath), entryFileContent);
  parse(entryFileContent);
  console.log(resolve);
};

type ResolvedId = string;
type ShakedSvelteFileContent = string;

const svelteShaker = async (
  entryFile: string,
  resolve: (id: string) => Promise<ResolvedId>,
): Promise<Record<ResolvedId, ShakedSvelteFileContent>> => {
  const path = await resolve(entryFile);
  const content = fs.readFileSync(path, 'utf-8');
  const { jsCode, nodeMap } = phase1(content, {});
  return { id: content };
};

export { svelteShaker };
