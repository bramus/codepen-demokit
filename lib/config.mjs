import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILENAME = 'config.json';

export const DEFAULT_SITE_CONFIG = Object.freeze({
  title: 'My CodePen Demos',
  subtitle: 'A collection of self-contained web demos.',
  footer: 'Powered by codepen-demokit.',
});

export const PROFILE_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
export const VISIBILITY_OPTIONS = Object.freeze([
  'Private',
  'Public',
  'Protected',
  'Collaborators',
]);
export const DEFAULT_VISIBILITY = 'Private';
export const VALID_VISIBILITIES = new Set(VISIBILITY_OPTIONS);

export function getConfigPath(projectDir = process.cwd()) {
  return path.resolve(projectDir, CONFIG_FILENAME);
}

function readRawConfigFile(configPath) {
  if (!fs.existsSync(configPath)) {
    return { status: 'missing', parsed: null, error: null };
  }

  let parsed;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    return { status: 'parse-error', parsed: null, error: err };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'invalid-root', parsed: null, error: null };
  }

  return { status: 'ok', parsed, error: null };
}

/**
 * Loads optional `site` metadata from `<projectDir>/config.json`, falling back
 * to DEFAULT_SITE_CONFIG when `config.json` or individual fields are omitted.
 */
export function loadSiteConfig(projectDir = process.cwd()) {
  const configPath = getConfigPath(projectDir);
  const { status, parsed } = readRawConfigFile(configPath);
  if (status !== 'ok') {
    return { ...DEFAULT_SITE_CONFIG };
  }

  const site =
    parsed.site && typeof parsed.site === 'object' && !Array.isArray(parsed.site)
      ? parsed.site
      : {};

  const pickString = (value, fallback) =>
    typeof value === 'string' && value.trim() ? value.trim() : fallback;

  return {
    title: pickString(site.title, DEFAULT_SITE_CONFIG.title),
    subtitle: pickString(site.subtitle, DEFAULT_SITE_CONFIG.subtitle),
    footer: pickString(site.footer, DEFAULT_SITE_CONFIG.footer),
  };
}

/**
 * Loads and strictly validates required `codepen` settings from `<projectDir>/config.json`.
 * Returns `{ ok: true, requiredProfile, defaultNewAccess }` or `{ ok: false, warnings: string[] }`.
 */
export function loadCodePenConfig(projectDir = process.cwd()) {
  const configPath = getConfigPath(projectDir);
  const { status, parsed, error } = readRawConfigFile(configPath);

  if (status === 'missing') {
    return {
      ok: false,
      warnings: [
        `Warning: ${CONFIG_FILENAME} not found at ${configPath}.`,
        `  Copy config.json.example to ${CONFIG_FILENAME} and configure "codepen.user" and "codepen.defaultVisibility".`,
      ],
    };
  }

  if (status === 'parse-error') {
    return {
      ok: false,
      warnings: [
        `Warning: Failed to read or parse ${CONFIG_FILENAME}: ${error.message}`,
        `  Ensure ${CONFIG_FILENAME} contains valid JSON (see config.json.example).`,
      ],
    };
  }

  if (status === 'invalid-root') {
    return {
      ok: false,
      warnings: [
        `Warning: ${CONFIG_FILENAME} must contain a JSON object.`,
        '  See config.json.example for the expected format.',
      ],
    };
  }

  const issues = [];
  const hasLegacyFlatKeys =
    typeof parsed.codepen_user === 'string' ||
    typeof parsed.codepen_default_visibility === 'string';

  const codepenSection =
    parsed.codepen && typeof parsed.codepen === 'object' && !Array.isArray(parsed.codepen)
      ? parsed.codepen
      : null;

  if (!codepenSection) {
    if (hasLegacyFlatKeys) {
      issues.push(
        'Legacy flat keys ("codepen_user" / "codepen_default_visibility") found; nest them under "codepen": { "user": "...", "defaultVisibility": "..." }.'
      );
    } else {
      issues.push('"codepen" section is missing.');
    }
  } else {
    const rawUser =
      typeof codepenSection.user === 'string' ? codepenSection.user.trim() : '';
    if (!rawUser) {
      issues.push('"codepen.user" is missing or empty.');
    } else if (!PROFILE_NAME_PATTERN.test(rawUser)) {
      issues.push(
        `"codepen.user" contains invalid characters (got "${rawUser}").`
      );
    }

    const rawVisibility =
      typeof codepenSection.defaultVisibility === 'string'
        ? codepenSection.defaultVisibility.trim()
        : '';
    if (!rawVisibility) {
      issues.push('"codepen.defaultVisibility" is missing or empty.');
    } else if (!VALID_VISIBILITIES.has(rawVisibility)) {
      issues.push(
        `"codepen.defaultVisibility" must be one of: ${[...VALID_VISIBILITIES].join(', ')} (got "${rawVisibility}").`
      );
    }

    if (issues.length === 0) {
      return {
        ok: true,
        requiredProfile: rawUser,
        defaultNewAccess: rawVisibility,
      };
    }
  }

  return {
    ok: false,
    warnings: [
      `Warning: ${CONFIG_FILENAME} is missing required configuration or contains invalid values:`,
      ...issues.map((issue) => `  - ${issue}`),
      '  See config.json.example for the expected format.',
    ],
  };
}

/**
 * Loads an optional `codepen.user` profile from `<projectDir>/config.json`.
 * Missing `config.json` or an empty `codepen.user` returns `{ ok: true, profile: null }`.
 * Invalid JSON or invalid `codepen.user` syntax returns `{ ok: false, warnings }`.
 */
export function loadCodePenProfile(projectDir = process.cwd()) {
  const configPath = getConfigPath(projectDir);
  const { status, parsed, error } = readRawConfigFile(configPath);

  if (status === 'missing') {
    return { ok: true, profile: null };
  }

  if (status === 'parse-error') {
    return {
      ok: false,
      warnings: [
        `Warning: Failed to read or parse ${CONFIG_FILENAME}: ${error.message}`,
        `  Ensure ${CONFIG_FILENAME} contains valid JSON (see config.json.example).`,
      ],
    };
  }

  if (status === 'invalid-root') {
    return {
      ok: false,
      warnings: [
        `Warning: ${CONFIG_FILENAME} must contain a JSON object.`,
        '  See config.json.example for the expected format.',
      ],
    };
  }

  const codepenSection =
    parsed.codepen && typeof parsed.codepen === 'object' && !Array.isArray(parsed.codepen)
      ? parsed.codepen
      : null;

  if (!codepenSection || typeof codepenSection.user !== 'string') {
    return { ok: true, profile: null };
  }

  const rawUser = codepenSection.user.trim();
  if (!rawUser) {
    return { ok: true, profile: null };
  }

  if (!PROFILE_NAME_PATTERN.test(rawUser)) {
    return {
      ok: false,
      warnings: [
        `Warning: ${CONFIG_FILENAME} contains an invalid "codepen.user" value ("${rawUser}").`,
        '  See config.json.example for the expected format.',
      ],
    };
  }

  return { ok: true, profile: rawUser };
}

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderShellIndexHtml(templateHtml, siteConfig) {
  const site = { ...DEFAULT_SITE_CONFIG, ...siteConfig };
  return templateHtml
    .replaceAll('{{SITE_TITLE}}', escapeHtml(site.title))
    .replaceAll('{{SITE_SUBTITLE}}', escapeHtml(site.subtitle))
    .replaceAll('{{SITE_FOOTER}}', escapeHtml(site.footer));
}
