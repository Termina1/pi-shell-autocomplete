## Context

Текущая реализация AI-автокомплита (см. `ai-completer.ts`) использует жёстко заданный путь к модели `starcoder2-3b-Q4_K_M.gguf` и передаёт в промпт только список из первых 8 элементов compinit-выпадающего списка. Файловая система и история команд не учитываются.

Структура текущего промпта:
```
# Choose one option and complete it naturally with arguments: <cmd1>, <cmd2>, ...
<частичная_команда>
```

Этот формат не даёт модели информации о том, какие файлы рядом (чтобы завершить `cd ` или `cat `), и какие команды пользователь недавно выполнял (чтобы повторить или продолжить цепочку).

**Ограничения текущей архитектуры:**
- `AiCompleter` не имеет доступа к shell-исполнителю (не может выполнить `ls` или прочитать `.zsh_history`)
- Модель одна и та же, независимо от доступных файлов
- Формат промпта фиксирован

## Goals / Non-Goals

**Goals:**
- Автоматический выбор лучшей доступной GGUF-модели из приоритетного списка (qwen2.5-coder → starcoder2 → deepseek-coder → любая найденная)
- Обогащение AI-промпта списком файлов/директорий из `cwd` (текущей рабочей директории процесса Pi)
- Обогащение AI-промпта последними N командами из `.zsh_history`
- Конфигурируемость: включение/выключение каждого источника контекста, приоритет моделей, лимиты
- Полная обратная совместимость: если файл starcoder2 — единственный доступный, поведение не меняется
- Сохранение debounce, кэширования и graceful degradation из текущей реализации

**Non-Goals:**
- Чтение содержимого файлов (только имена/пути)
- Умный парсинг `.zsh_history` с частотами и давностью (только последние N строк)
- Поддержка bash-истории или других shell
- Динамическая смена `cwd` во время сессии (используется cwd на момент старта сессии)
- A/B-тестирование качества моделей — выбор основан на общепринятых бенчмарках

## Decisions

### 1. Приоритетный список моделей с автоопределением

```typescript
interface AiConfig {
  // Новое: список путей к моделям в порядке приоритета
  modelPriority: string[];
  // Старое (deprecated, но поддерживается для обратной совместимости):
  modelPath: string;
  // ... остальные поля
}
```

**Логика выбора модели:**
1. Пройти по `modelPriority` и вернуть первый существующий файл
2. Если `modelPriority` пуст — использовать `modelPath` (старое поведение)
3. Если ни один файл не найден — `aiLoadError = true`, ghost text отключён

**Приоритет по умолчанию:**
```
[
  "models/qwen2.5-coder-3b-instruct-Q4_K_M.gguf",
  "models/qwen2.5-coder-1.5b-instruct-Q4_K_M.gguf",
  "models/starcoder2-3b-Q4_K_M.gguf",
  "models/deepseek-coder-1.3b-instruct-Q4_K_M.gguf"
]
```

**Rationale**: Qwen2.5-Coder показывает лучшие результаты на бенчмарках FIM (HumanEval, MBPP) среди open-source моделей <7B. При этом мы сохраняем fallback на starcoder2 (уже может быть скачан) и deepseek-coder. Пользователь может переопределить список.

**Альтернатива**: Использовать API-модели (Copilot, Codeium). Отклонено: требует сетевого доступа, нарушает локальный-first принцип расширения.

### 2. Сбор файлового контекста

Новый метод в `AiCompleter` (или отдельный модуль `context-collector.ts`):

```typescript
async function collectFileContext(cwd: string, maxFiles: number): Promise<string[]> {
  // fs.readdir(cwd) → отфильтровать скрытые (`.`), отсортировать (директории первее)
  // Вернуть первые maxFiles имён
}
```

**Формат в промпте:**
```
# Files in current directory:
#   src/
#   package.json
#   README.md
#   ...
```

**Rationale**: Список файлов критичен для команд вроде `cd`, `cat`, `vim`, `ls`, `cp`, `mv` — без него модель гадает. `maxFiles` по умолчанию = 20, чтобы не перегружать промпт.

**Альтернатива**: Передавать только файлы, matching-префикс токена. Отклонено: сложный парсинг, модель сама может выбрать релевантное.

### 3. Сбор истории команд

Чтение `.zsh_history` напрямую (файл в домашней директории):

```typescript
async function collectHistoryContext(maxEntries: number): Promise<string[]> {
  // fs.readFile('~/.zsh_history') → взять последние maxEntries строк
  // Отфильтровать строки с timestamp-префиксом (формат: `: 1234567890:0;command`)
  // Вернуть чистые команды
}
```

**Формат в промпте:**
```
# Recent commands:
#   git status
#   npm test
#   docker compose up
```

**Rationale**: История — сильнейший предиктор следующей команды. Пользователи часто повторяют команды или выполняют их с небольшими вариациями. `maxEntries` по умолчанию = 10.

**Альтернатива**: Использовать `fc -l` через zsh. Отклонено: требует spawn zsh, медленнее, чем чтение файла.

### 4. Новый формат промпта

```
# Choose one option and complete it naturally with arguments.
# Available commands: <cmd1>, <cmd2>, ...
# Recent commands:
#   <hist1>
#   <hist2>
# Files in directory:
#   <file1>
#   <file2>
<префикс_пользователя>
```

Секции `# Recent commands:` и `# Files in directory:` опциональны — добавляются только если соответствующий источник включён в конфигурации.

**Rationale**: Структурированный промпт с комментариями в стиле FIM. Модель видит контекст до префикса и завершает строку после него. Порядок секций: compinit-результаты (наиболее релевантные для выбора команды) → история (паттерны использования) → файлы (аргументы-пути).

### 5. Интеграция сбора контекста в AiCompleter

```typescript
class AiCompleter {
  constructor(
    private config: AiConfig,
    private modelLoader: ModelLoader,
    private contextCollector: ContextCollector, // Новая зависимость
  ) {}

  // В методе predict:
  async predict(token, items, onResult) {
    // ...
    const fileCtx = await this.contextCollector.getFileContext();
    const histCtx = await this.contextCollector.getHistoryContext();
    const prompt = this.buildPrompt(token, items, fileCtx, histCtx);
    const result = await completion.generateInfillCompletion(prompt, "", opts);
    // ...
  }
}
```

**ContextCollector** — новый интерфейс/класс:
```typescript
interface ContextCollector {
  getFileContext(): Promise<string[]>;
  getHistoryContext(): Promise<string[]>;
}
```

Это позволяет мокать сбор контекста в тестах и не привязывать `AiCompleter` к конкретным механизмам чтения файлов.

**Rationale**: Dependency injection сохраняет тестируемость `AiCompleter`. Контекст собирается асинхронно, но внутри debounce-колбэка (не блокирует UI).

### 6. Конфигурация новых источников

```typescript
interface AiConfig {
  // Существующие поля сохраняются
  enabled: boolean;
  modelPath: string;              // deprecated, остаётся для обратной совместимости
  modelPriority: string[];        // новое: приоритетный список моделей
  debounceMs: number;
  maxTokens: number;
  contextSize: number;
  
  // Новые поля:
  fileContext: {
    enabled: boolean;             // default: true
    maxFiles: number;             // default: 20
  };
  historyContext: {
    enabled: boolean;             // default: true
    maxEntries: number;           // default: 10
    historyPath: string;          // default: "~/.zsh_history"
  };
}
```

**Rationale**: Пользователь может отключить файловый контекст (если медленно на сетевых FS), отключить историю (если приватно), изменить путь к истории (для нестандартных shell-конфигураций).

## Risks / Trade-offs

| Risk | Mitigation |
|------|------------|
| **fs.readdir на сетевой файловой системе** — медленно, может тормозить дебаунс | Таймаут на `readdir` (500ms), fallback к пустому списку файлов. Опция отключения `fileContext.enabled = false`. |
| **Чтение .zsh_history может нарушить приватность** — пользователь не ожидает, что его история передаётся модели | Всё происходит локально, модель тоже локальная. Данные не покидают машину. Добавить комментарий в README. |
| **Большой промпт уменьшает доступный контекст для FIM** | Лимиты по умолчанию (20 файлов + 10 команд = ~500 chars) консервативны. contextSize можно увеличить. |
| **Qwen2.5-Coder может быть недоступен** (не скачан) | Авто-fallback на starcoder2. Уведомление пользователю не показываем (не хотим спамить). |
| **Формат .zsh_history может отличаться** (EXTENDED_HISTORY, разные опции) | Парсим оба формата: с timestamp-префиксом (`: 123:0;cmd`) и без. Некорректные строки пропускаем. |
| **Изменение промпта может ухудшить качество для случаев без файлов/истории** | Сохраняем первую строку промпта неизменной (`# Choose one option...`). Остальные секции — аддитивные. |
| **Увеличение времени инференса из-за длинного промпта** | Дополнительные токены (~100-200) пренебрежимо малы по сравнению с общим временем инференса (200-500ms). |

## Migration Plan

1. Добавить новые поля в `AiConfig` с дефолтами
2. Реализовать `ContextCollector` (новый файл `context-collector.ts`)
3. Модифицировать `AiCompleter` для приёма `ContextCollector` и нового формата промпта
4. Добавить `createModelLoader` с автоопределением модели
5. Обновить `index.ts` для проброса новых зависимостей
6. Обновить тесты
7. Документировать новые возможности в README

**Обратная совместимость**: Старый `modelPath` продолжает работать. Если `modelPriority` пуст, используется `modelPath`. Если оба контекста отключены, формат промпта идентичен текущему.

**Откат**: Установка `fileContext.enabled = false` и `historyContext.enabled = false` возвращает поведение к текущему.

## Open Questions

- **Нужно ли кэшировать файловый контекст?** `readdir` на локальном диске занимает <1ms для ~100 файлов. Пока — нет. Если появятся жалобы на тормоза — добавим TTL-кэш на 2-3 секунды.
- **Стоит ли добавить контекст git-статуса?** (`git status --short`). Полезно для `git add`, `git commit`, но добавляет latency (spawn git). Пока вне scope, можно добавить позже.
- **Нужно ли сортировать историю по частоте?** Пока просто последние N. Частотный анализ может быть следующим улучшением.
