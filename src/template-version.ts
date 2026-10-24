// The template version of this core and the marker that the launcher carries. The marker is data the core
// reads, never runs. Node built-ins only, no Playwright module.
import fs from 'node:fs';
import path from 'node:path';
import type { RunWarning } from './protocol.ts';

/** Version of the files a project copies from templates/; the marker in monitor.bat holds the same number. */
export const TEMPLATE_VERSION = 1 as const;

/** File name of the launcher in a monitoring project. */
export const LAUNCHER_FILE = 'monitor.bat' as const;

/** The marker line of the launcher: `rem blw-template: <n>`, on any line, in any letter case. */
export const LAUNCHER_MARKER = /^rem[ \t]+blw-template:[ \t]*(\d{1,6})[ \t]*$/im;

/** How many bytes from the start of the launcher the core reads to find the marker. */
export const LAUNCHER_HEAD_BYTES = 4096 as const;

/** The template version a launcher text declares, or undefined when it declares none. */
export function readLauncherMarker(text: string): number | undefined {
  const match = LAUNCHER_MARKER.exec(text);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * The warning for a launcher of the project that is older than this core, or undefined when there is
 * nothing to say. Never throws: a missing launcher (a direct run) and an unreadable one give undefined. It
 * reads the head only, so an edited or huge file costs nothing. The warning holds two numbers and no text of
 * the file.
 */
export function launcherWarning(root: string): RunWarning | undefined {
  let text: string;
  try {
    const fd = fs.openSync(path.join(root, LAUNCHER_FILE), 'r');
    try {
      const head = Buffer.alloc(LAUNCHER_HEAD_BYTES);
      const read = fs.readSync(fd, head, 0, LAUNCHER_HEAD_BYTES, 0);
      text = head.toString('latin1', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  const found = readLauncherMarker(text);
  if (found !== undefined && found >= TEMPLATE_VERSION) {
    return undefined;
  }
  return found === undefined
    ? { code: 'launcher_outdated', expected: TEMPLATE_VERSION }
    : { code: 'launcher_outdated', found, expected: TEMPLATE_VERSION };
}
