import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{ a: ({ children }) => <span className="external-label">{children}</span> }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
