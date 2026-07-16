import ReactMarkdown, {
  type AllowElement,
  type Components,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  REPORT_MARKDOWN_ALLOWED_ELEMENTS,
  REPORT_MARKDOWN_LIMITS,
  reportMarkdownUrlTransform,
  safeReportUrl,
} from './report-markdown-policy';

export type ReportMarkdownProps = {
  children?: string;
  className?: string;
};

export function ReportMarkdown({
  children = '',
  className,
}: ReportMarkdownProps) {
  return (
    <div className={className ?? 'report-markdown'}>
      <ReactMarkdown
        allowedElements={REPORT_MARKDOWN_ALLOWED_ELEMENTS}
        allowElement={createReportMarkdownAllowElement()}
        components={reportMarkdownComponents}
        remarkPlugins={[remarkGfm]}
        skipHtml
        unwrapDisallowed
        urlTransform={reportMarkdownUrlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

const reportMarkdownComponents: Components = {
  a({ children, href }) {
    const safeHref = safeReportUrl(href);
    return safeHref ? (
      <a href={safeHref} rel="noreferrer" target="_blank">
        {children}
      </a>
    ) : (
      <span className="report-markdown-inert-link">{children}</span>
    );
  },
  blockquote({ children }) {
    return <blockquote>{children}</blockquote>;
  },
  br() {
    return <br />;
  },
  code({ children }) {
    return <code>{children}</code>;
  },
  del({ children }) {
    return <del>{children}</del>;
  },
  em({ children }) {
    return <em>{children}</em>;
  },
  h2({ children }) {
    return <h2>{children}</h2>;
  },
  h3({ children }) {
    return <h3>{children}</h3>;
  },
  h4({ children }) {
    return <h4>{children}</h4>;
  },
  hr() {
    return <hr />;
  },
  li({ children }) {
    return <li>{children}</li>;
  },
  ol({ children, start }) {
    return (
      <ol start={typeof start === 'number' ? start : undefined}>{children}</ol>
    );
  },
  p({ children }) {
    return <p>{children}</p>;
  },
  pre({ children }) {
    return <pre>{children}</pre>;
  },
  strong({ children }) {
    return <strong>{children}</strong>;
  },
  table({ children }) {
    return <table>{children}</table>;
  },
  tbody({ children }) {
    return <tbody>{children}</tbody>;
  },
  td({ align, children }) {
    return <td align={safeAlignment(align)}>{children}</td>;
  },
  th({ align, children }) {
    return <th align={safeAlignment(align)}>{children}</th>;
  },
  thead({ children }) {
    return <thead>{children}</thead>;
  },
  tr({ children }) {
    return <tr>{children}</tr>;
  },
  ul({ children }) {
    return <ul>{children}</ul>;
  },
};

function createReportMarkdownAllowElement(): AllowElement {
  let links = 0;
  const blocked = new WeakSet<object>();

  return (element) => {
    if (blocked.has(element)) return false;
    if (element.tagName === 'a') {
      links += 1;
      return links <= REPORT_MARKDOWN_LIMITS.linksPerSlide;
    }
    if (element.tagName === 'table' && !tableIsWithinBounds(element)) {
      blockDescendants(element, blocked);
      return false;
    }
    if (element.tagName === 'pre' || element.tagName === 'code') {
      if (
        textContent(element).length > REPORT_MARKDOWN_LIMITS.codeBlockCharacters
      ) {
        blockDescendants(element, blocked);
        return false;
      }
    }
    if (
      element.tagName === 'blockquote' ||
      element.tagName === 'ol' ||
      element.tagName === 'ul'
    ) {
      if (containerDepth(element) > REPORT_MARKDOWN_LIMITS.nestingDepth) {
        blockDescendants(element, blocked);
        return false;
      }
    }
    return true;
  };
}

function blockDescendants(node: MarkdownNode, blocked: WeakSet<object>) {
  for (const child of childElements(node)) {
    blocked.add(child);
    blockDescendants(child, blocked);
  }
}

function tableIsWithinBounds(element: MarkdownNode) {
  const rows = descendants(element, 'tr');
  const bodyRows = descendants(element, 'tbody').flatMap((body) =>
    descendants(body, 'tr'),
  );
  if (bodyRows.length > REPORT_MARKDOWN_LIMITS.tableBodyRows) return false;

  return rows.every((row) => {
    const cells = childElements(row).filter(
      (child) => child.tagName === 'th' || child.tagName === 'td',
    );
    return (
      cells.length <= REPORT_MARKDOWN_LIMITS.tableColumns &&
      cells.every(
        (cell) =>
          textContent(cell).length <=
          REPORT_MARKDOWN_LIMITS.tableCellCharacters,
      )
    );
  });
}

function containerDepth(element: MarkdownNode): number {
  const childDepths = childElements(element).map((child) =>
    containerDepth(child),
  );
  const nestedDepth = childDepths.length > 0 ? Math.max(...childDepths) : 0;
  return isContainer(element) ? nestedDepth + 1 : nestedDepth;
}

function isContainer(node: MarkdownNode) {
  return (
    node.tagName === 'blockquote' ||
    node.tagName === 'ol' ||
    node.tagName === 'ul'
  );
}

function descendants(element: MarkdownNode, tagName: string): MarkdownNode[] {
  return childElements(element).flatMap((child) => [
    ...(child.tagName === tagName ? [child] : []),
    ...descendants(child, tagName),
  ]);
}

function childElements(node: MarkdownNode): MarkdownNode[] {
  if (!Array.isArray(node.children)) return [];
  return node.children.filter(
    (child): child is MarkdownNode =>
      Boolean(child) &&
      typeof child === 'object' &&
      'tagName' in child &&
      typeof child.tagName === 'string',
  );
}

function textContent(node: MarkdownNode): string {
  if (!Array.isArray(node.children)) return '';
  return node.children
    .map((child) => {
      if (!child || typeof child !== 'object') return '';
      if ('value' in child && typeof child.value === 'string') {
        return child.value;
      }
      return textContent(child as MarkdownNode);
    })
    .join('');
}

function safeAlignment(
  value: unknown,
): 'left' | 'center' | 'right' | undefined {
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : undefined;
}

type MarkdownNode = {
  tagName?: string;
  children?: readonly unknown[];
};
