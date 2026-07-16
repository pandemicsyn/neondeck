import type {
  ReportDocument,
  ReportDocumentItem,
  ReportDocumentSection,
} from '../../../../shared/report-document';

export function reportDocumentFromLegacyHtml(
  html: string,
): ReportDocument | null {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  const main = parsed.querySelector('main');
  const header = directChild(main, 'HEADER');
  const title = text(header?.querySelector('h1'));
  const generatedAt = text(header?.querySelector('.meta'))?.replace(
    /^generated\s+/iu,
    '',
  );
  if (!main || !header || !title || !generatedAt) return null;

  return {
    eyebrow: text(header.querySelector('.eyebrow')),
    title,
    summary: text(header.querySelector('.summary')),
    generatedAt,
    sections: [...main.children]
      .filter((child) => child.tagName === 'SECTION')
      .map(parseSection)
      .filter((section): section is ReportDocumentSection => section !== null),
  };
}

function parseSection(section: Element): ReportDocumentSection | null {
  const title = text(directChild(section, 'H2'));
  if (!title) return null;
  const body = text(directChild(section, 'P'));
  const descriptionList = directChild(section, 'DL');
  return {
    title,
    body,
    items: descriptionList ? parseItems(descriptionList) : [],
  };
}

function parseItems(list: Element) {
  const items: ReportDocumentItem[] = [];
  const children = [...list.children];
  for (let index = 0; index < children.length; index += 1) {
    const label = children[index];
    const value = children[index + 1];
    if (label?.tagName !== 'DT' || value?.tagName !== 'DD') continue;
    const itemValue = text(value);
    if (!itemValue) continue;
    items.push({ label: text(label), value: itemValue });
    index += 1;
  }
  return items;
}

function directChild(parent: Element | null, tagName: string) {
  return parent
    ? ([...parent.children].find((child) => child.tagName === tagName) ?? null)
    : null;
}

function text(element: Element | null | undefined) {
  return element?.textContent?.trim() || null;
}
