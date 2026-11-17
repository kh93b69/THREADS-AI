/**
 * Показывает план публикаций вперёд — какая тема в какой слот выйдет.
 *   npm run test:schedule
 *
 * Ничего не публикует и не тратит токены: только считает ротацию.
 */
import { DEFAULT_TONE, TOPICS, pickTopic } from "../src/content/topics.js";
import { config } from "../src/config/env.js";
import { formatInZone, normalizeTime } from "../src/services/scheduler/Scheduler.js";

const times = [...new Set(config.autopost.times.map(normalizeTime))].sort();
const timezone = config.autopost.timezone;
const slotsToShow = 10;

console.log(`Расписание: ${times.join(", ")} (${timezone})`);
console.log(`Автопостинг включён: ${config.autopost.enabled}`);
console.log(`Тем в контент-плане: ${TOPICS.length}\n`);

const now = new Date();
let shown = 0;
let dayOffset = 0;

while (shown < slotsToShow) {
  const day = new Date(now.getTime() + dayOffset * 86_400_000);
  const { date, time: currentTime } = formatInZone(day, timezone);

  for (const [slotIndex, slotTime] of times.entries()) {
    // В сегодняшнем дне пропускаем слоты, которые уже прошли.
    if (dayOffset === 0 && slotTime <= currentTime) continue;
    if (shown >= slotsToShow) break;

    const picked = pickTopic(day, slotIndex, times.length);
    console.log(`${date} ${slotTime}  ${picked.topic}`);
    console.log(`                  тон: ${picked.tone ?? DEFAULT_TONE}\n`);
    shown++;
  }
  dayOffset++;
}
