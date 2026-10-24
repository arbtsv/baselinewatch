// The Russian strings of the report and the console. Machine tokens (class, recheck and reason
// tokens, PASS and FAIL, paths) stay as they are inside the sentences; the machine lines are not
// made from this file.
import { MIN_REDACT_LENGTH } from '../protocol.ts';
import type { Catalog } from './catalog.ts';

export const ru: Catalog = {
  reportTitle: 'Отчёт baselinewatch',
  labelRunId: 'Идентификатор запуска',
  labelStartedAt: 'Начало',
  labelFinishedAt: 'Окончание',
  labelLocale: 'Язык',
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
      case 'history_not_written':
        return warning.pass === undefined
          ? 'Историю запусков (runs.csv) не удалось обновить; подробности в cli-error.log в каталоге запуска.'
          : `Строки метрик прохода ${warning.pass} не удалось добавить в metrics.csv.`;
      case 'lock_taken_over':
        return 'Блокировка, оставшаяся от прежнего запуска, который уже не работает, перехвачена.';
      case 'retention_failed':
        return `Старые элементы запусков, которые не удалось удалить: ${warning.count ?? '?'}; следующий запуск повторит попытку.`;
      case 'secret_too_short': {
        const subject = warning.field === 'login' ? 'Логин' : warning.field === 'password' ? 'Пароль' : 'Логин или пароль';
        return `${subject} учётной записи короче ${MIN_REDACT_LENGTH} символов и не скрывается в данных запуска.`;
      }
      case 'binary_left_out':
        return `Файлы, не включённые в zip, потому что их не удалось очистить от логина или пароля учётной записи: ${warning.count ?? '?'}.`;
      case 'zip_skipped':
        return 'Zip не создан: он создаётся только в Windows.';
      case 'zip_failed':
        return 'Не удалось создать zip; файлы запуска остались в каталоге запуска.';
      case 'launcher_outdated':
        return warning.found === undefined
          ? `В запускающем файле monitor.bat нет версии шаблона, которую ядро может прочитать (ожидается ${warning.expected ?? '?'}); выполните blw init --refresh, чтобы обновить его.`
          : `Запускающий файл monitor.bat имеет версию шаблона ${warning.found}, а ядро ожидает более новую, ${warning.expected ?? '?'}; выполните blw init --refresh, чтобы обновить его.`;
    }
  },
  resultLine: (result, reason) => (reason === null ? `Результат: ${result}` : `Результат: ${result} (${reason})`),
  reportSaved: (path) => `Отчёт: ${path}`,
  notReady: (reason) => `Окружение не готово (${reason}).`,
  internalError: (logPath) => `baselinewatch остановлен из-за внутренней ошибки; подробности: ${logPath}`,
};
