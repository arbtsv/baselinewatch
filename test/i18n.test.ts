// Tests for the language catalogs: both languages define the same keys with the same kind of value,
// every sentence renders for every token, the machine prefixes never enter a catalog, and the Russian
// text is Russian. The Cyrillic checks use the code point range U+0400 to U+04FF, so this file holds no Russian text.
// Run: node --test test/i18n.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Catalog } from '../src/i18n/catalog.ts';
import { en } from '../src/i18n/en.ts';
import { catalogFor } from '../src/i18n/index.ts';
import { ru } from '../src/i18n/ru.ts';
import {
  FAIL_REASONS,
  NOT_READY_REASONS,
  RESULT_TOKENS,
  WARNING_CODES,
  type Reason,
  type RunWarning,
} from '../src/protocol.ts';

const CYRILLIC = new RegExp(`[${String.fromCodePoint(0x0400)}-${String.fromCodePoint(0x04ff)}]`);
const KEYS = Object.keys(en) as (keyof Catalog)[];
const SAMPLE_PATH = 'artifacts/report.txt';
const REASONS: readonly Reason[] = [...NOT_READY_REASONS, ...FAIL_REASONS];

// Warnings with every optional field and with none, for each code.
const WARNINGS: RunWarning[] = WARNING_CODES.flatMap((code) => [
  { code, pass: 2 as const, scenario: 'demo', node: 'node-1' },
  { code },
  { code, field: 'login' as const, count: 3 },
]);

const NEW_CODES = [
  'lock_taken_over',
  'retention_failed',
  'secret_too_short',
  'binary_left_out',
  'zip_skipped',
  'zip_failed',
  'launcher_outdated',
] as const;

// Every sentence of a catalog rendered for every token: [label, rendered text, expected token].
function samples(catalog: Catalog): { label: string; text: string; token?: string }[] {
  return [
    ...WARNINGS.map((warning) => ({ label: `warning ${JSON.stringify(warning)}`, text: catalog.warning(warning) })),
    ...RESULT_TOKENS.flatMap((result) => [
      { label: `resultLine ${result} null`, text: catalog.resultLine(result, null), token: result },
      ...REASONS.map((reason) => ({
        label: `resultLine ${result} ${reason}`,
        text: catalog.resultLine(result, reason),
        token: `${result} (${reason})`,
      })),
    ]),
    { label: 'reportSaved', text: catalog.reportSaved(SAMPLE_PATH), token: SAMPLE_PATH },
    ...NOT_READY_REASONS.map((reason) => ({ label: `notReady ${reason}`, text: catalog.notReady(reason), token: reason })),
    { label: 'internalError', text: catalog.internalError(SAMPLE_PATH), token: SAMPLE_PATH },
  ];
}

describe('catalog completeness', () => {
  test('en and ru define the same keys', () => {
    assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
  });

  test('every key holds the same kind of value in both languages', () => {
    for (const key of KEYS) {
      assert.equal(typeof ru[key], typeof en[key], key);
    }
  });

  test('every plain string is non-empty', () => {
    for (const catalog of [en, ru]) {
      for (const key of KEYS) {
        const value = catalog[key];
        if (typeof value === 'string') {
          assert.ok(value.trim().length > 0, key);
        }
      }
    }
  });

  test('every sentence renders a non-empty string for every token', () => {
    for (const catalog of [en, ru]) {
      for (const { label, text } of samples(catalog)) {
        assert.equal(typeof text, 'string', label);
        assert.ok(text.trim().length > 0, label);
      }
    }
  });

  test('the tokens appear untranslated in every sentence that names them', () => {
    for (const catalog of [en, ru]) {
      for (const { label, text, token } of samples(catalog)) {
        if (token !== undefined) {
          assert.ok(text.includes(token), `${label}: ${text}`);
        }
      }
    }
  });
});

describe('the new warnings', () => {
  test('the vocabulary holds the seven new codes after the earlier three', () => {
    assert.deepEqual(WARNING_CODES.slice(3), NEW_CODES);
  });

  test('the new warnings name no path, file and value', () => {
    for (const [language, catalog] of [['en', en], ['ru', ru]] as const) {
      for (const code of NEW_CODES) {
        const text = catalog.warning({ code, field: 'password', count: 7 });
        for (const forbidden of ['/', '\\', '.log', '.json', '.csv', 'placeholder']) {
          assert.ok(!text.includes(forbidden), `${language} ${code} holds ${JSON.stringify(forbidden)}: ${text}`);
        }
        if (code === 'retention_failed' || code === 'binary_left_out') {
          assert.ok(text.includes('7'), `${language} ${code}: ${text}`);
        }
      }
    }
    assert.ok(en.warning({ code: 'secret_too_short', field: 'password' }).includes('password'));
    assert.match(ru.warning({ code: 'secret_too_short', field: 'password' }), CYRILLIC);
  });

  test('the field and the count decide the wording, and a missing one still renders', () => {
    assert.ok(en.warning({ code: 'secret_too_short', field: 'login' }).includes('login'));
    assert.ok(en.warning({ code: 'secret_too_short' }).includes('login or password'));
    assert.ok(en.warning({ code: 'retention_failed' }).includes('?'));
    assert.notEqual(ru.warning({ code: 'secret_too_short', field: 'login' }), ru.warning({ code: 'secret_too_short', field: 'password' }));
  });
});

describe('the launcher warning', () => {
  const FORMS = [
    { code: 'launcher_outdated', found: 0, expected: 1 },
    { code: 'launcher_outdated', expected: 1 },
  ] as const satisfies readonly RunWarning[];

  test('the English sentence names the numbers, the launcher and the command', () => {
    const [withFound, withoutFound] = FORMS.map((form) => en.warning(form)) as [string, string];
    for (const needle of ['0', '1', 'monitor.bat', 'npx blw init --refresh']) {
      assert.ok(withFound.includes(needle), `${needle}: ${withFound}`);
    }
    for (const needle of ['1', 'monitor.bat', 'npx blw init --refresh']) {
      assert.ok(withoutFound.includes(needle), `${needle}: ${withoutFound}`);
    }
    assert.ok(!withoutFound.includes('undefined'), withoutFound);
  });

  test('the Russian sentence is Russian and keeps the launcher and the command as they are', () => {
    for (const form of FORMS) {
      const text = ru.warning(form);
      assert.match(text, CYRILLIC);
      assert.ok(text.includes('monitor.bat'), text);
      assert.ok(text.includes('npx blw init --refresh'), text);
      assert.ok(!text.includes('undefined'), text);
    }
  });

  test('no form in either language holds a path separator or a file extension other than .bat', () => {
    for (const catalog of [en, ru]) {
      for (const form of [...FORMS, { code: 'launcher_outdated' as const }]) {
        const text = catalog.warning(form);
        for (const forbidden of ['/', '\\', '.json', '.log', '.csv', 'undefined']) {
          assert.ok(!text.includes(forbidden), `${JSON.stringify(forbidden)} in ${text}`);
        }
      }
    }
  });
});

describe('machine prefixes', () => {
  test('no string value and no rendered sentence contains RESULT= or REASON=', () => {
    for (const catalog of [en, ru]) {
      const texts = [
        ...KEYS.flatMap((key) => (typeof catalog[key] === 'string' ? [catalog[key] as string] : [])),
        ...samples(catalog).map((sample) => sample.text),
      ];
      for (const text of texts) {
        assert.ok(!text.includes('RESULT='), text);
        assert.ok(!text.includes('REASON='), text);
      }
    }
  });
});

describe('Russian text', () => {
  test('every Russian string that differs from the English one contains a Cyrillic letter', () => {
    for (const key of KEYS) {
      const russian = ru[key];
      if (typeof russian === 'string' && russian !== en[key]) {
        assert.match(russian, CYRILLIC, key);
      }
    }
  });

  test('every Russian sentence that differs from the English one contains a Cyrillic letter', () => {
    const english = samples(en);
    samples(ru).forEach(({ label, text }, index) => {
      if (text !== english[index]?.text) {
        assert.match(text, CYRILLIC, label);
      }
    });
  });

  test('the report title differs between the languages', () => {
    assert.notEqual(ru.reportTitle, en.reportTitle);
    assert.match(ru.reportTitle, CYRILLIC);
  });

  test('the English catalog has no Cyrillic letter', () => {
    for (const { text } of samples(en)) {
      assert.doesNotMatch(text, CYRILLIC);
    }
    for (const key of KEYS) {
      const value = en[key];
      if (typeof value === 'string') {
        assert.doesNotMatch(value, CYRILLIC, key);
      }
    }
  });
});

describe('catalogFor', () => {
  test('maps each locale to its catalog', () => {
    assert.equal(catalogFor('en'), en);
    assert.equal(catalogFor('ru'), ru);
  });
});
