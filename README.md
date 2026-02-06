# codex-darcula-theme

Утилита для локального патча Desktop-приложения `Codex.app` под палитру, похожую на дефолтную **Darcula** из Android Studio.

## Зачем

В Codex Desktop сейчас есть только переключение `light/dark` без пользовательской палитры.
Этот скрипт внедряет CSS поверх тёмного режима, чтобы интерфейс выглядел ближе к Darcula, и при этом сохраняет возможность отката.

## Что делает

- создаёт бэкап `app.asar` рядом с приложением (`app.asar.bak-darcula`),
- патчит bundle внутри `app.asar` (целевая точка: `.vite/build/main-CQwPb0Th.js`),
- вставляет Darcula CSS после загрузки окна,
- синхронизирует `ElectronAsarIntegrity` (hash в `Info.plist`) с новым `app.asar`,
- умеет восстановить оригинальный `app.asar` из бэкапа,
- по умолчанию делает ad-hoc `codesign`, чтобы снизить риск блокировки macOS после правки.

## Использование

```bash
cd /Users/deniszabozhanov/dev/tools/codex-darcula-theme
node ./codex-darcula-theme.js status
node ./codex-darcula-theme.js patch
node ./codex-darcula-theme.js restore
```

Опции:

- `--app /Applications/Codex.app` — путь к приложению, если он нестандартный.
- `--no-codesign` — не выполнять `codesign` после patch/restore.

## Важно

- После обновления Codex патч обычно слетает, потому что обновляется `app.asar`.
- В этом случае просто повторно запусти `patch`.
