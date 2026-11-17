import { createLogger } from "../../utils/logger.js";

const log = createLogger("scheduler");

/** Как часто сверяемся с расписанием. */
const TICK_MS = 30_000;

export interface SchedulerOptions {
  /** Времена публикации в формате "HH:MM", в часовом поясе timezone. */
  times: string[];
  /** IANA-зона, например "Europe/Moscow". */
  timezone: string;
  /** Что запускать. slotIndex — номер времени в отсортированном списке. */
  job: (slotIndex: number, slotsPerDay: number) => Promise<unknown>;
}

/**
 * Планировщик на setInterval, без cron-зависимостей.
 *
 * Раз в 30 секунд смотрит текущее время в заданном часовом поясе и, если
 * HH:MM совпало с одним из слотов, запускает задачу. Уже отработанные слоты
 * помнит по ключу "YYYY-MM-DD HH:MM", поэтому за один тик-в-минуту слот
 * не выстреливает дважды.
 *
 * Ограничение: память живёт вместе с контейнером. Если Railway редеплоит
 * ровно в минуту слота, пост может уйти второй раз. Держи один реплик
 * и не деплой в минуты публикаций — либо переноси отметки в Postgres.
 */
export class Scheduler {
  private readonly times: string[];
  private readonly timezone: string;
  private readonly job: SchedulerOptions["job"];
  private readonly fired = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(options: SchedulerOptions) {
    this.times = [...new Set(options.times.map(normalizeTime))].sort();
    this.timezone = options.timezone;
    this.job = options.job;

    if (this.times.length === 0) {
      throw new Error("Расписание пустое: задай POST_TIMES, например \"09:00,19:00\".");
    }
    // Проверяем зону сразу, а не в первый тик через час после деплоя.
    formatInZone(new Date(), this.timezone);
  }

  start(): void {
    if (this.timer) return;
    log.info("Планировщик запущен", { times: this.times, timezone: this.timezone });
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // Проверяем сразу, не ожидая первого тика.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Состояние для GET /schedule. */
  status(): {
    times: string[];
    timezone: string;
    now: string;
    nextRun: string;
    firedToday: string[];
  } {
    const now = new Date();
    const { date, time } = formatInZone(now, this.timezone);

    return {
      times: this.times,
      timezone: this.timezone,
      now: `${date} ${time}`,
      nextRun: this.nextRunAfter(time),
      firedToday: [...this.fired].filter((key) => key.startsWith(date)),
    };
  }

  private nextRunAfter(currentTime: string): string {
    const upcoming = this.times.find((time) => time > currentTime);
    return upcoming ? `сегодня ${upcoming}` : `завтра ${this.times[0]}`;
  }

  private async tick(): Promise<void> {
    // Публикация может идти дольше тика — не наслаиваем запуски.
    if (this.running) return;

    const { date, time } = formatInZone(new Date(), this.timezone);
    const slotIndex = this.times.indexOf(time);
    if (slotIndex === -1) return;

    const key = `${date} ${time}`;
    if (this.fired.has(key)) return;
    this.fired.add(key);

    this.running = true;
    try {
      log.info("Слот наступил, запускаю задачу", { key, slotIndex });
      await this.job(slotIndex, this.times.length);
    } catch (error) {
      // Планировщик не должен падать из-за одного неудачного поста:
      // следующий слот всё равно должен отработать.
      log.error("Задача по расписанию упала", { key, error: String(error) });
    } finally {
      this.running = false;
      this.forgetOldKeys(date);
    }
  }

  /** Чтобы Set не рос бесконечно: держим отметки только за сегодня и вчера. */
  private forgetOldKeys(today: string): void {
    const yesterday = new Date(`${today}T00:00:00Z`);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    const keep = yesterday.toISOString().slice(0, 10);

    for (const key of this.fired) {
      const day = key.slice(0, 10);
      if (day !== today && day !== keep) this.fired.delete(key);
    }
  }
}

/** "9:5" → "09:05", с проверкой на мусор. */
export function normalizeTime(raw: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!match) {
    throw new Error(`Время "${raw}" не в формате HH:MM.`);
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Время "${raw}" вне диапазона 00:00–23:59.`);
  }

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

/** Текущие дата и время в нужной зоне, без сторонних библиотек. */
export function formatInZone(date: Date, timezone: string): { date: string; time: string } {
  try {
    const parts = new Intl.DateTimeFormat("sv-SE", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);

    // Формат sv-SE даёт "2026-11-17 09:05" — удобно резать.
    const [datePart, timePart] = parts.split(" ");
    if (!datePart || !timePart) throw new Error(`Неожиданный формат даты: ${parts}`);
    return { date: datePart, time: timePart };
  } catch (error) {
    throw new Error(
      `Не удалось прочитать часовой пояс "${timezone}". Укажи IANA-зону, например Europe/Moscow. ${String(error)}`,
    );
  }
}
