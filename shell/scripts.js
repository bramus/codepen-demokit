const directoryEl = document.getElementById('demo-directory');
const cardTemplate = document.getElementById('demo-card-template');
const emptyStateTemplate = document.getElementById('empty-state-template');

function toSafeLocalHref(rawHref) {
  if (typeof rawHref !== 'string' || !rawHref.startsWith('./')) {
    return null;
  }
  try {
    const resolved = new URL(rawHref, window.location.href);
    if (
      resolved.origin !== window.location.origin ||
      (resolved.protocol !== 'http:' && resolved.protocol !== 'https:')
    ) {
      return null;
    }
    return rawHref;
  } catch {
    return null;
  }
}

function toSafeCodePenUrl(rawUrl) {
  if (typeof rawUrl !== 'string') {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.hostname !== 'codepen.io' && !parsed.hostname.endsWith('.codepen.io')) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function createHeading(level, className) {
  const clamped = Math.min(Math.max(level, 2), 6);
  const heading = document.createElement(`h${clamped}`);
  heading.className = className;
  return heading;
}

function createDemoCard(demo, headingLevel) {
  const safeHref = toSafeLocalHref(demo?.href);
  if (!safeHref) return null;

  const title = typeof demo?.title === 'string' && demo.title.trim() ? demo.title.trim() : demo.path;
  const fragment = cardTemplate.content.cloneNode(true);
  const cardEl = fragment.querySelector('.demo-card');

  const headingEl = createHeading(headingLevel, 'demo-card-title');
  const linkEl = document.createElement('a');
  linkEl.className = 'demo-link';
  linkEl.setAttribute('href', safeHref);
  linkEl.textContent = title;
  headingEl.append(linkEl);
  cardEl.prepend(headingEl);

  const descriptionEl = fragment.querySelector('.demo-description');
  if (typeof demo?.description === 'string' && demo.description.trim()) {
    descriptionEl.textContent = demo.description.trim();
  } else {
    descriptionEl.remove();
  }

  const pathEl = fragment.querySelector('.demo-path');
  pathEl.textContent = typeof demo?.path === 'string' ? demo.path : safeHref.replace(/^\.\//, '');

  const codepenEl = fragment.querySelector('.demo-codepen');
  const safeCodePenUrl = toSafeCodePenUrl(demo?.codepenUrl);
  if (safeCodePenUrl) {
    codepenEl.setAttribute('href', safeCodePenUrl);
    codepenEl.setAttribute('aria-label', `CodePen for ${title}`);
  } else {
    codepenEl.remove();
  }

  return fragment;
}

function createGroupSection(headingText, demos, subgroups = [], headingLevel = 2) {
  const cards = (Array.isArray(demos) ? demos : [])
    .map((demo) => createDemoCard(demo, headingLevel + 1))
    .filter(Boolean);

  const childSections = (Array.isArray(subgroups) ? subgroups : [])
    .map((subgroup) => {
      const subHeading =
        typeof subgroup?.title === 'string' && subgroup.title.trim()
          ? subgroup.title.trim()
          : String(subgroup?.id ?? 'Demos');
      return createGroupSection(subHeading, subgroup?.demos, subgroup?.groups, headingLevel + 1);
    })
    .filter(Boolean);

  if (cards.length === 0 && childSections.length === 0) {
    return null;
  }

  const section = document.createElement('section');
  section.className = 'demo-group';

  const headingEl = createHeading(headingLevel, 'demo-group-title');
  headingEl.textContent = headingText;
  section.append(headingEl);

  if (cards.length > 0) {
    const gridEl = document.createElement('ul');
    gridEl.className = 'demo-grid';
    gridEl.setAttribute('role', 'list');
    gridEl.replaceChildren(...cards);
    section.append(gridEl);
  }

  if (childSections.length > 0) {
    const subgroupsEl = document.createElement('div');
    subgroupsEl.className = 'demo-subgroups';
    subgroupsEl.replaceChildren(...childSections);
    section.append(subgroupsEl);
  }

  return section;
}

function createCode(text) {
  const code = document.createElement('code');
  code.textContent = text;
  return code;
}

function createErrorState() {
  const section = document.createElement('section');
  section.className = 'empty-state';

  const heading = document.createElement('h2');
  heading.textContent = 'Unable to load demos';

  const paragraph = document.createElement('p');
  paragraph.append(
    'Run ',
    createCode('npm run build'),
    ' to generate ',
    createCode('dist/demos.json'),
    ', or start the dev server with ',
    createCode('npm start'),
    ' to build and watch it automatically.',
  );

  section.append(heading, paragraph);
  return section;
}

async function loadDemos() {
  try {
    const response = await fetch('./demos.json', {
      cache: 'no-store',
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const groups = Array.isArray(data?.groups) ? data.groups : [];
    const standalone = Array.isArray(data?.standalone) ? data.standalone : [];

    const sections = [];

    for (const group of groups) {
      const heading =
        typeof group?.title === 'string' && group.title.trim()
          ? group.title.trim()
          : String(group?.id ?? 'Demos');
      const section = createGroupSection(heading, group?.demos, group?.groups, 2);
      if (section) sections.push(section);
    }

    if (standalone.length > 0) {
      const standaloneHeading = sections.length > 0 ? 'Standalone Demos' : 'Demos';
      const section = createGroupSection(standaloneHeading, standalone, [], 2);
      if (section) sections.push(section);
    }

    if (sections.length === 0) {
      directoryEl.replaceChildren(emptyStateTemplate.content.cloneNode(true));
      return;
    }

    directoryEl.replaceChildren(...sections);
  } catch {
    directoryEl.replaceChildren(createErrorState());
  }
}

loadDemos();
