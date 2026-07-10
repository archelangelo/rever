import { useEffect, useState } from 'react';
import { createHighlighter, type Highlighter } from 'shiki';

const THEME = 'github-light';
const LANGS = [
  'javascript',
  'jsx',
  'typescript',
  'tsx',
  'json',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'css',
  'html',
  'markdown',
  'bash',
  'yaml',
  'sql',
  'ruby',
  'php',
];

let highlighterPromise: Promise<Highlighter> | null = null;

function loadHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: LANGS });
  return highlighterPromise;
}

const EXT_TO_LANG: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  py: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  css: 'css',
  html: 'html',
  md: 'markdown',
  sh: 'bash',
  bash: 'bash',
  yml: 'yaml',
  yaml: 'yaml',
  sql: 'sql',
  rb: 'ruby',
  php: 'php',
};

/** Map a file path to a loaded Shiki language, or null when we don't highlight it. */
export function langFor(path: string | null): string | null {
  const ext = path?.split('.').pop()?.toLowerCase() ?? '';
  return EXT_TO_LANG[ext] ?? null;
}

export interface Tok {
  content: string;
  color?: string;
}

/** Tokenize a single line's content; returns one plain token on any failure. */
export function tokenizeLine(hl: Highlighter, content: string, lang: string): Tok[] {
  if (content === '') return [{ content: '' }];
  try {
    const { tokens } = hl.codeToTokens(content, { lang, theme: THEME });
    return (tokens[0] ?? [{ content }]).map((t) => ({ content: t.content, color: t.color }));
  } catch {
    return [{ content }];
  }
}

/** React hook: resolves the shared highlighter (null until ready / on failure). */
export function useHighlighter(): Highlighter | null {
  const [hl, setHl] = useState<Highlighter | null>(null);
  useEffect(() => {
    let live = true;
    loadHighlighter()
      .then((h) => live && setHl(h))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return hl;
}
