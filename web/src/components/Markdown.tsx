import { Children, isValidElement, memo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import { Check, Copy } from 'lucide-react';
import { copyText } from '../lib/clipboard';

function nodeText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return '';
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = Children.toArray(children).find(isValidElement) as
    | { props: { className?: string; children?: ReactNode } }
    | undefined;
  const lang = /language-([\w+#-]+)/.exec(code?.props.className ?? '')?.[1];
  const raw = nodeText(code?.props.children).replace(/\n$/, '');
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="codeblock-lang">{lang ?? 'code'}</span>
        <button
          type="button"
          className="codeblock-copy"
          onClick={async () => {
            if (await copyText(raw)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            }
          }}
          aria-label="Copy code"
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="table-wrap">
      <table>{children}</table>
    </div>
  ),
  // Remote images are never loaded (privacy + prompt-injection exfiltration); show alt text instead.
  img: ({ alt }) => <span className="md-img-alt">{alt ? `[image: ${alt}]` : '[image]'}</span>,
};

const remarkPlugins = [remarkGfm];
const rehypePlugins = [[rehypeHighlight, { detect: false, ignoreMissing: true }]] as never;

export const Markdown = memo(function Markdown({ content }: { content: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
