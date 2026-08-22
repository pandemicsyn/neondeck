import ReactMarkdown, {
  type AllowElement,
  type Components,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';
import * as v from 'valibot';
import {
  REPORT_MARKDOWN_ALLOWED_ELEMENTS,
  REPORT_MARKDOWN_LIMITS,
  reportMarkdownUrlTransform,
  safeReportUrl,
} from './report-markdown-policy';

export type ReportMarkdownProps = {
  children?: string;
  className?: string;
  linkBudget?: ReportMarkdownLinkBudget;
};

export type ReportMarkdownLinkBudget = {
  artifact: { count: number; max: number };
  slide: { count: number; max: number };
};

export function ReportMarkdown({
  children = '',
  className,
  linkBudget,
}: ReportMarkdownProps) {
  return (
    <div className={className ?? 'report-markdown'}>
      <ReactMarkdown
        allowedElements={REPORT_MARKDOWN_ALLOWED_ELEMENTS}
        allowElement={createReportMarkdownAllowElement(linkBudget)}
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
    return <ol start={start}>{children}</ol>;
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

function createReportMarkdownAllowElement(
  linkBudget?: ReportMarkdownLinkBudget,
): AllowElement {
  const fallbackBudget = {
    artifact: { count: 0, max: REPORT_MARKDOWN_LIMITS.linksPerArtifact },
    slide: { count: 0, max: REPORT_MARKDOWN_LIMITS.linksPerSlide },
  };
  const budget = linkBudget ?? fallbackBudget;
  const blocked = new WeakSet<object>();

  return (element) => {
    if (blocked.has(element)) return false;
    if (element.tagName === 'a') {
      if (
        budget.slide.count >= budget.slide.max ||
        budget.artifact.count >= budget.artifact.max
      ) {
        return false;
      }
      budget.slide.count += 1;
      budget.artifact.count += 1;
      return true;
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
  return (node.children ?? []).flatMap((child) => {
    const parsed = v.safeParse(markdownNodeSchema, child);
    return parsed.success && parsed.output.tagName ? [parsed.output] : [];
  });
}

function textContent(node: MarkdownNode): string {
  return (node.children ?? [])
    .map((child) => {
      const parsed = v.safeParse(markdownContentNodeSchema, child);
      if (!parsed.success) return '';
      if (parsed.output.value !== undefined) return parsed.output.value;
      return textContent(parsed.output);
    })
    .join('');
}

function safeAlignment(
  value: string | undefined,
): 'left' | 'center' | 'right' | undefined {
  return value === 'left' || value === 'center' || value === 'right'
    ? value
    : undefined;
}

const markdownContentNodeSchema = v.looseObject({
  tagName: v.optional(v.string()),
  value: v.optional(v.string()),
  children: v.optional(v.array(v.unknown())),
});
const markdownNodeSchema = v.pipe(
  markdownContentNodeSchema,
  v.check((node) => node.tagName !== undefined),
);
type MarkdownNode = v.InferOutput<typeof markdownContentNodeSchema>;
