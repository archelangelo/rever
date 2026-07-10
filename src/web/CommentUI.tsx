import { useState } from 'react';
import type { UiThread } from './api.js';

export function CommentComposer({
  placeholder,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  return (
    <div className="composer" data-testid="composer">
      <textarea
        data-testid="composer-textarea"
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="composer-actions">
        <button
          className="primary"
          data-testid="composer-submit"
          disabled={!text.trim()}
          onClick={() => onSubmit(text.trim())}
        >
          Comment
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

const VERDICTS = ['comment', 'approve', 'request_changes'] as const;

export function SummaryComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string, verdict: (typeof VERDICTS)[number]) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [verdict, setVerdict] = useState<(typeof VERDICTS)[number]>('comment');
  return (
    <div className="composer" data-testid="summary-composer">
      <textarea
        data-testid="summary-textarea"
        placeholder="Overall review summary…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      <div className="composer-actions">
        <select data-testid="verdict-select" value={verdict} onChange={(e) => setVerdict(e.target.value as never)}>
          <option value="comment">Comment</option>
          <option value="approve">Approve</option>
          <option value="request_changes">Request changes</option>
        </select>
        <button className="primary" data-testid="summary-submit" disabled={!text.trim()} onClick={() => onSubmit(text.trim(), verdict)}>
          Submit summary
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

export function ThreadView({
  thread,
  onReply,
}: {
  thread: UiThread;
  onReply: (threadId: number, body: string) => void;
}) {
  const [replying, setReplying] = useState(false);
  return (
    <div className={`thread${thread.published ? '' : ' draft'}`} data-testid="thread">
      {thread.kind === 'summary' && thread.verdict && (
        <span className={`verdict verdict-${thread.verdict}`}>{thread.verdict.replace('_', ' ')}</span>
      )}
      {thread.status === 'resolved' && <span className="resolved-badge">resolved</span>}
      <ul className="comments">
        {thread.comments.map((c) => (
          <li key={c.id} className={`comment author-${c.author}`} style={{ marginLeft: `${c.depth * 1.25}rem` }}>
            <span className="author">{c.author}</span>
            {!c.published && <span className="draft-badge">draft</span>}
            <div className="body">{c.body}</div>
          </li>
        ))}
      </ul>
      {replying ? (
        <CommentComposer
          placeholder="Reply…"
          onSubmit={(b) => {
            onReply(thread.threadId, b);
            setReplying(false);
          }}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <button className="reply-btn" data-testid="reply-btn" onClick={() => setReplying(true)}>
          Reply
        </button>
      )}
    </div>
  );
}
