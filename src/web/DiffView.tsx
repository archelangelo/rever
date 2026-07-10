import { useState, type ReactNode } from 'react';
import type { Highlighter } from 'shiki';
import type { DiffLine, FileDiff } from '../types/index.js';
import type { NewThread, UiThread } from './api.js';
import { CommentComposer, ThreadView } from './CommentUI.js';
import { langFor, tokenizeLine, useHighlighter } from './highlight.js';

const lineKey = (path: string, side: 'old' | 'new', line: number) => `${path}:${side}:${line}`;

export function DiffView({
  files,
  threads,
  onCreateThread,
  onReply,
}: {
  files: FileDiff[];
  threads: UiThread[];
  onCreateThread: (input: NewThread) => void;
  onReply: (threadId: number, body: string) => void;
}) {
  const hl = useHighlighter();
  const [activeKey, setActiveKey] = useState<string | null>(null);

  const inlineByKey = new Map<string, UiThread[]>();
  for (const t of threads) {
    if (t.kind === 'inline' && t.filePath && t.side && t.endLine != null) {
      const k = lineKey(t.filePath, t.side, t.endLine);
      const list = inlineByKey.get(k) ?? [];
      list.push(t);
      inlineByKey.set(k, list);
    }
  }

  if (files.length === 0) return <p className="empty">No changes in this snapshot.</p>;
  return (
    <div className="diff">
      {files.map((f, i) => (
        <FileBlock
          key={i}
          file={f}
          hl={hl}
          inlineByKey={inlineByKey}
          fileThreads={threads.filter((t) => t.kind === 'file' && t.filePath === (f.newPath ?? f.oldPath))}
          activeKey={activeKey}
          setActiveKey={setActiveKey}
          onCreateThread={onCreateThread}
          onReply={onReply}
        />
      ))}
    </div>
  );
}

interface FileBlockProps {
  file: FileDiff;
  hl: Highlighter | null;
  inlineByKey: Map<string, UiThread[]>;
  fileThreads: UiThread[];
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
  onCreateThread: (input: NewThread) => void;
  onReply: (threadId: number, body: string) => void;
}

function FileBlock({ file, hl, inlineByKey, fileThreads, activeKey, setActiveKey, onCreateThread, onReply }: FileBlockProps) {
  const path = file.newPath ?? file.oldPath ?? '(unknown)';
  const title = file.oldPath && file.newPath && file.oldPath !== file.newPath ? `${file.oldPath} → ${file.newPath}` : path;
  const lang = langFor(file.newPath ?? file.oldPath);
  const fileKey = `file:${path}`;

  return (
    <section className="diff-file" data-testid="diff-file">
      <header className="diff-file-header">
        <span className={`badge badge-${file.changeType}`}>{file.changeType}</span>
        <span className="path" data-testid="file-path">{title}</span>
        <span className="stat add" data-testid="file-additions">+{file.additions}</span>
        <span className="stat del" data-testid="file-deletions">−{file.deletions}</span>
        <button className="file-comment-btn" title="Comment on file" onClick={() => setActiveKey(activeKey === fileKey ? null : fileKey)}>
          💬
        </button>
      </header>

      {fileThreads.map((t) => (
        <div className="file-thread" key={t.threadId}>
          <ThreadView thread={t} onReply={onReply} />
        </div>
      ))}
      {activeKey === fileKey && (
        <div className="file-thread">
          <CommentComposer
            placeholder="Comment on this file…"
            onSubmit={(body) => {
              onCreateThread({ kind: 'file', filePath: path, body });
              setActiveKey(null);
            }}
            onCancel={() => setActiveKey(null)}
          />
        </div>
      )}

      {file.binary ? (
        <div className="notice">Binary file — no diff shown.</div>
      ) : file.tooLarge ? (
        <div className="notice">File too large to display ({file.additions + file.deletions} changed lines).</div>
      ) : (
        <table className="hunks">
          <tbody>
            {file.hunks.map((h, hi) => (
              <HunkRows
                key={hi}
                lines={h.lines}
                header={h.header}
                hl={hl}
                lang={lang}
                path={path}
                inlineByKey={inlineByKey}
                activeKey={activeKey}
                setActiveKey={setActiveKey}
                onCreateThread={onCreateThread}
                onReply={onReply}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

interface HunkRowsProps {
  lines: DiffLine[];
  header?: string;
  hl: Highlighter | null;
  lang: string | null;
  path: string;
  inlineByKey: Map<string, UiThread[]>;
  activeKey: string | null;
  setActiveKey: (k: string | null) => void;
  onCreateThread: (input: NewThread) => void;
  onReply: (threadId: number, body: string) => void;
}

function HunkRows({ lines, header, hl, lang, path, inlineByKey, activeKey, setActiveKey, onCreateThread, onReply }: HunkRowsProps) {
  return (
    <>
      <tr className="hunk-header">
        <td className="gutter" />
        <td className="gutter" />
        <td className="content">{header ? `… ${header}` : '…'}</td>
      </tr>
      {lines.map((l, i) => {
        const side: 'old' | 'new' = l.type === 'del' ? 'old' : 'new';
        const num = l.type === 'del' ? l.oldLine : l.newLine;
        const key = num != null ? lineKey(path, side, num) : null;
        const here = key ? (inlineByKey.get(key) ?? []) : [];
        return (
          <FragmentRows key={i}>
            <tr className={`line line-${l.type}`} data-testid={`line-${l.type}`}>
              <td className="gutter">{l.oldLine ?? ''}</td>
              <td className="gutter">{l.newLine ?? ''}</td>
              <td className="content">
                {key && (
                  <button
                    className="line-comment-btn"
                    data-testid={`comment-btn-${key}`}
                    title="Comment on this line"
                    onClick={() => setActiveKey(activeKey === key ? null : key)}
                  >
                    +
                  </button>
                )}
                <span className="marker">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                <Content content={l.content} hl={hl} lang={lang} />
              </td>
            </tr>
            {here.map((t) => (
              <tr className="thread-row" key={`t${t.threadId}`}>
                <td colSpan={3}>
                  <ThreadView thread={t} onReply={onReply} />
                </td>
              </tr>
            ))}
            {key && activeKey === key && (
              <tr className="composer-row">
                <td colSpan={3}>
                  <CommentComposer
                    placeholder="Leave a comment on this line…"
                    onSubmit={(body) => {
                      onCreateThread({ kind: 'inline', filePath: path, side, startLine: num!, endLine: num!, body });
                      setActiveKey(null);
                    }}
                    onCancel={() => setActiveKey(null)}
                  />
                </td>
              </tr>
            )}
          </FragmentRows>
        );
      })}
    </>
  );
}

// Table rows can't be wrapped in a real element, so use a keyed fragment.
function FragmentRows({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

function Content({ content, hl, lang }: { content: string; hl: Highlighter | null; lang: string | null }) {
  if (!hl || !lang) return <span>{content}</span>;
  return (
    <span>
      {tokenizeLine(hl, content, lang).map((t, i) => (
        <span key={i} style={t.color ? { color: t.color } : undefined}>
          {t.content}
        </span>
      ))}
    </span>
  );
}
