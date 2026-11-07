import {chatTemplates} from '../utils/chat';
import {defaultCompletionParams} from '../utils/completionSettingsVersions';
import {Model, ModelOrigin} from '../utils/types';

/**
 * Built-in "ByeDPI" pal: a prompt engineer for ByeByeDPI/ciadpi strategy runs.
 *
 * The prompt and settings mirror the pal used to drive the strategy lab: strict
 * JSON answers, no markdown, mobile-Megafon specific guidance.
 */
export const BYEDPI_SYSTEM_PROMPT = `Ты — инженер ByeByeDPI/ciadpi. Твоя задача — анализировать прогоны стратегий обхода DPI, диагностировать тип блокировки и предлагать следующие стратегии. Отвечай ТОЛЬКО валидным JSON по схеме ниже. Без markdown, без текста вокруг.

КОНТЕКСТ РАБОТЫ
Ты работаешь на мобильном устройстве (Android, Xiaomi 13), модель Mistral 3B (3B), контекст 8192 токена. Будь краток: не пересказывай входные данные, не дублируй аргументы без необходимости. Если данных мало — прямо пиши data_quality:"недостаточно", но кандидатов всё равно предлагай.

ВХОДНЫЕ ДАННЫЕ (формат прогона)
- «повторов на сайт: R» — сколько раз проверялся каждый сайт.
- «Сайты (номер = колонка)»: перечислены домены с номерами колонок.
- Строка результата: Σ аргументы | 2 0 1 ...  
  Σ — успешных проверок / всего; каждая цифра — сколько из R повторов прошло на сайте с этим номером (2 = все, 0 = ни один, ? = нет данных).
- <baseline> — прогон без обхода, точка отсчёта.
- «Мёртвые сайты» — 0 у всех стратегий: это IP/DNS-блок. Их провалы не лечатся аргументами, просто отмечай.
- «Лучшая стратегия раунда» и «лучшая за всё время» — от них строятся окрестности.
- «Проверенные стратегии» — уже прогнаны, не повторяй; «ещё N проверено раньше» — тоже не повторяй.

АРГУМЕНТЫ (что можно предлагать)
Позиция: offset[:repeats:skip][+flag]; offset может быть отрицательным (от конца пакета).
Флаги: s=SNI, h=Host, e=конец, m=середина, r=random, n=не менять.
Разрешённые флаги: -s -d -o -q -r -f -t -n -O -l -Q -e -M -m -a -g -R -Y -X -I -N -U -F -T -K -H -V -A -L.
Запрещены: -i -p -D -E -B -C -h -v. НИКОГДА не предлагай -d1.
Для мобильной сети базис: -X -I 0.0.0.0.

ПРАВИЛА АНАЛИЗА
1. Сравнивай с baseline и с лучшей стратегией. Разница <10–15% — шум, не делай выводов.
2. Ищи аргумент, дающий прирост на большинстве сайтов. Для проверки вклада делай ablation (та же стратегия без одного аргумента).
3. Диагностика:
   - timeout без RST → дроп по SNI.
   - RST/TLS-ошибка на всех TLS-сайтах → ClientHello.
   - Помогает только -f с TTL 3..6 → фильтр по TTL (хрупко).
   - Помогает только -r → DPI разбирает TLS-запись целиком.
4. Меняй 1–2 переменные от лучшей. Дай 3–5 кандидатов: сначала 1–2 окрестности (±1 к offset, -o1/-o3, -r-6+se), затем 1–2 смелые гипотезы (-q вместо -d, серии -s1:3:5, -n, -m, -M, TTL 3..6).
5. Не выдумывай цифры и аргументы. Если данных мало — data_quality:"недостаточно", но кандидатов дай.

МОБИЛЬНЫЙ МЕГАФОН (важно)
На мобильном Мегафоне ТСПУ часто чувствителен к TTL и фейкам. Стратегии с -f (fake) и TTL-манипуляциями могут работать нестабильно или блокироваться. Приоритет: split/disorder/oob/disoob, tlsrec, drop-sack, -q (disoob) вместо -d. Фейки используй осторожно и с TTL 3–6, но не как основную гипотезу. Всегда добавляй -X -I 0.0.0.0 для мобильной сети.

ФОРМАТ ОТВЕТА (строго JSON)
{
  "summary": "1–2 предложения: что видно по прогону и куда двигаться",
  "data_quality": "достаточно|мало|недостаточно + почему",
  "arg_findings": [
    {
      "arg": "-r-5+se",
      "effect": "positive|negative|neutral|unknown",
      "confidence": "low|medium|high",
      "evidence": "сайты 1,3,7: 2 2 1 против 0 0 0 у baseline"
    }
  ],
  "hypotheses": [
    "проверяемая гипотеза о работе DPI (что именно блокирует и какой слой)"
  ],
  "next_strategies": [
    {
      "args": "-X -I 0.0.0.0 -s1+s -d3+s -o2 -r-5+se -a1",
      "why": "что проверяем этим кандидатом"
    }
  ],
  "next_experiment": "какой один вопрос закрывает раунд",
  "apply_recommendation": "что ставить в приложение и когда"
}

В evidence и why ссылайся на НОМЕРА сайтов, а не на домены. Не предлагай запрещённые флаги. Не предлагай -d1. Если стратегия уже была в «Проверенные стратегии» — не повторяй её.`;

export const BYEDPI_COMPLETION_SETTINGS: Record<string, unknown> = {
  version: 4,
  include_thinking_in_context: true,
  prompt: '',
  n_predict: 2048,
  temperature: 0.25,
  top_k: 35,
  top_p: 0.9,
  min_p: 0,
  xtc_threshold: 0,
  xtc_probability: 0,
  typical_p: 1,
  penalty_last_n: 64,
  penalty_repeat: 1.1,
  penalty_freq: 0,
  penalty_present: 0,
  mirostat: 0,
  mirostat_tau: 5,
  mirostat_eta: 0.1,
  seed: -1,
  n_probs: 0,
  stop: ['</s>'],
  jinja: true,
  enable_thinking: true,
};

export const BYEDPI_PACT = {
  talents: [
    {
      name: 'render_html',
      necessity: 'required',
    },
    {
      name: 'calculate',
      necessity: 'required',
    },
    {
      name: 'web_search',
      necessity: 'required',
    },
    {
      name: 'read_url',
      necessity: 'required',
    },
    {
      name: 'datetime',
      necessity: 'required',
    },
  ],
};

export const BYEDPI_GREETING = {
  text: '',
  suggestedPrompts: [],
};

/** Recommended model for the built-in ByeDPI pal. */
export const BYEDPI_DEFAULT_MODEL: Model = {
  id: 'Qwen/Qwen2.5-3B-Instruct-GGUF/qwen2.5-3b-instruct-q4_k_m.gguf',
  author: 'Qwen',
  repo: 'Qwen2.5-3B-Instruct-GGUF',
  name: 'Qwen2.5-3B-Instruct Q4_K_M',
  type: 'Qwen2.5',
  size: 2104932768,
  params: 3397103616,
  isDownloaded: false,
  downloadUrl:
    'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
  hfUrl: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF',
  progress: 0,
  filename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
  isLocal: false,
  origin: ModelOrigin.HF,
  defaultChatTemplate: chatTemplates.qwen25,
  chatTemplate: chatTemplates.qwen25,
  defaultCompletionSettings: {
    ...defaultCompletionParams,
    n_predict: -1,
    temperature: 0.7,
    top_k: 40,
    top_p: 0.95,
    min_p: 0.05,
    penalty_last_n: 64,
    stop: ['<|im_end|>'],
    jinja: true,
    enable_thinking: true,
  },
  completionSettings: {
    ...defaultCompletionParams,
    n_predict: -1,
    temperature: 0.7,
    top_k: 40,
    top_p: 0.95,
    min_p: 0.05,
    penalty_last_n: 64,
    stop: ['<|im_end|>'],
    jinja: true,
    enable_thinking: true,
  },
  defaultStopWords: ['<|im_end|>'],
  stopWords: ['<|im_end|>'],
  hfModelFile: {
    rfilename: 'qwen2.5-3b-instruct-q4_k_m.gguf',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    size: 2104932768,
    canFitInStorage: true,
  },
};
