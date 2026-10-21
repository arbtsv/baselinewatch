// Catalog lookup by the locale that env.json names.
import type { Locale } from '../env.ts';
import type { Catalog } from './catalog.ts';
import { en } from './en.ts';
import { ru } from './ru.ts';

const CATALOGS: Record<Locale, Catalog> = { en, ru };

/** The catalog of a locale. An unknown locale is already a configuration error in env.json. */
export function catalogFor(locale: Locale): Catalog {
  return CATALOGS[locale];
}
