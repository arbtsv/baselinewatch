// The Russian strings of the report and the console. Machine tokens (class, recheck and reason
// tokens, PASS and FAIL, paths) stay as they are inside the sentences; the machine lines are not
// made from this file.
import type { Catalog } from './catalog.ts';

export const ru: Catalog = {
  reportTitle: 'Отчёт baselinewatch',
  labelRunId: 'Идентификатор запуска',
  labelStartedAt: 'Начало',
  labelFinishedAt: 'Окончание',
  labelLocale: 'Язык',
  labelResult: 'Результат',
  colScenario: 'Сценарий',
  colNode: 'Узел',
  colClass: 'Класс',
  colMetric: 'Метрика',
  colMs: 'мс',
  colReference: 'Эталон',
  colLimit: 'Предел',
  colRatio: 'Отношение',
  colVerdict: 'Вердикт',
  colRecheck: 'Перепроверка',
  noNodes: 'Ни один узел не был измерен.',
  sectionNotMeasured: 'Не измерено',
  sectionUnusedBaselines: 'Неиспользованные эталоны',
  sectionWarnings: 'Предупреждения',
  none: '(нет)',
  warning: (warning) => {
    switch (warning.code) {
      case 'pass_invalid':
        return warning.pass === undefined
          ? 'Файл прохода отсутствует или повреждён; его результаты не использованы.'
          : `Файл прохода ${warning.pass} отсутствует или повреждён; его результаты не использованы.`;
      case 'pass_2_not_built':
        return `Повторная проверка ${warning.scenario ?? '?'} / ${warning.node ?? '?'} не дала результата.`;
    }
  },
  resultLine: (result, reason) => (reason === null ? `Результат: ${result}` : `Результат: ${result} (${reason})`),
  reportSaved: (path) => `Отчёт: ${path}`,
  notReady: (reason) => `Окружение не готово (${reason}).`,
  internalError: (logPath) => `baselinewatch остановлен из-за внутренней ошибки; подробности: ${logPath}`,
};
