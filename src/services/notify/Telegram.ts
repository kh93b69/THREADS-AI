import { request } from "../../utils/http.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("telegram");

const TELEGRAM_API = "https://api.telegram.org";

interface SendMessageResponse {
  ok: boolean;
  result?: { message_id: number };
  description?: string;
}

interface UpdatesResponse {
  ok: boolean;
  result: Array<{
    message?: { chat: { id: number; type: string; first_name?: string; title?: string } };
    channel_post?: { chat: { id: number; type: string; title?: string; first_name?: string } };
  }>;
}

export interface ChatInfo {
  id: number;
  type: string;
  name: string;
}

/**
 * Уведомления в Телеграм. Намеренно «мягкий» сервис: если токен не задан или
 * Телеграм недоступен, молча ничего не делаем — публикация поста не должна
 * падать из-за того, что не ушло уведомление.
 */
export class Telegram {
  private readonly token: string | undefined;
  private readonly chatId: string | undefined;

  constructor(options?: { token?: string; chatId?: string }) {
    this.token = (options?.token ?? process.env["TELEGRAM_BOT_TOKEN"])?.trim() || undefined;
    this.chatId = (options?.chatId ?? process.env["TELEGRAM_CHAT_ID"])?.trim() || undefined;
  }

  get configured(): boolean {
    return Boolean(this.token && this.chatId);
  }

  /** Отправка с HTML-разметкой. Возвращает false вместо исключения. */
  async send(text: string): Promise<boolean> {
    if (!this.configured) {
      log.debug("Телеграм не настроен — уведомление пропущено");
      return false;
    }

    try {
      const data = await request<SendMessageResponse>(
        `${TELEGRAM_API}/bot${this.token}/sendMessage`,
        {
          method: "POST",
          body: {
            chat_id: this.chatId,
            text,
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          },
        },
      );

      if (!data.ok) {
        log.warn("Телеграм отклонил сообщение", { description: data.description });
        return false;
      }
      return true;
    } catch (error) {
      log.warn("Не смог отправить в Телеграм", { error: String(error) });
      return false;
    }
  }

  /** Кто писал боту — чтобы вытащить chat_id без ручного копания в API. */
  async findChats(): Promise<ChatInfo[]> {
    if (!this.token) throw new Error("Не задан TELEGRAM_BOT_TOKEN.");

    const data = await request<UpdatesResponse>(`${TELEGRAM_API}/bot${this.token}/getUpdates`);
    const chats = new Map<number, ChatInfo>();

    for (const update of data.result ?? []) {
      const chat = update.message?.chat ?? update.channel_post?.chat;
      if (!chat) continue;
      const named = chat as { first_name?: string; title?: string };
      chats.set(chat.id, {
        id: chat.id,
        type: chat.type,
        name: named.first_name ?? named.title ?? "—",
      });
    }

    return [...chats.values()];
  }
}

/** Экранирование под parse_mode: HTML. */
export function escapeTg(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
