// The template version of this core and the marker that the launcher carries. The marker is data the core
// reads, never runs. Node built-ins only, no Playwright module.

/** Version of the files a project copies from templates/; the marker in monitor.bat holds the same number. */
export const TEMPLATE_VERSION = 1 as const;

/** File name of the launcher in a monitoring project. */
export const LAUNCHER_FILE = 'monitor.bat' as const;

/** The marker line of the launcher: `rem blw-template: <n>`, on any line, in any letter case. */
export const LAUNCHER_MARKER = /^rem[ \t]+blw-template:[ \t]*(\d{1,6})[ \t]*$/im;

/** The template version a launcher text declares, or undefined when it declares none. */
export function readLauncherMarker(text: string): number | undefined {
  void text;
  return undefined;
}
