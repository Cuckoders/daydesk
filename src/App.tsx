import { FormEvent, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  Clock3,
  Coffee,
  Download,
  FilePlus2,
  Inbox,
  LayoutDashboard,
  LayoutGrid,
  ListTodo,
  LoaderCircle,
  LockKeyhole,
  Mail,
  Menu,
  MessageSquare,
  MoreHorizontal,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  Search,
  Server,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Star,
  Trash2,
  Utensils,
  Video,
  X,
} from "lucide-react";
import { connectImap, disconnectImap, downloadImapAttachment, getImapMessageContent, syncImap, type RemoteMailMessage } from "./services/mail";
import { clearMailAttachments, selectMailAttachments, sendMail, type SelectedMailAttachment } from "./services/compose";
import { loadMailCache, replaceMailCache, searchMailCache } from "./services/mailCache";
import { notify } from "./services/notifications";
import { connectOAuth, disconnectOAuth, downloadOAuthAttachment, getOAuthMessageContent, getOAuthProviderStatus, syncOAuth, type OAuthProvider, type OAuthProviderStatus } from "./services/oauth";
import { loadState, saveState, stateChannel } from "./services/storage";
import type { AppState, CalendarEvent, MailAccount, MailAttachment, MailMessage, Task } from "./types";

type View = "today" | "tasks" | "calendar" | "mail" | "widgets";

const navItems: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: "today", label: "Сегодня", icon: LayoutDashboard },
  { id: "tasks", label: "Задачи", icon: ListTodo },
  { id: "calendar", label: "Календарь", icon: CalendarDays },
  { id: "mail", label: "Почта", icon: Mail },
  { id: "widgets", label: "Виджеты", icon: LayoutGrid },
];

const shortTime = (iso: string) => new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const longDate = (date: Date) => new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long" }).format(date);
const weekday = (date: Date) => new Intl.DateTimeFormat("ru-RU", { weekday: "short" }).format(date).replace(".", "");
const uid = () => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const sameDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
const pad = (value: number) => String(value).padStart(2, "0");
const inputDate = (iso: string) => {
  const date = new Date(iso);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
const inputTime = (iso: string) => {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const combineDateTime = (date: string, time: string) => new Date(`${date}T${time}:00`).toISOString();
const fileSize = (bytes: number) => {
  if (bytes <= 0) return "Размер неизвестен";
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
};

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function Logo() {
  return (
    <div className="logo-mark" aria-label="DayDesk">
      <span />
      <span />
      <span />
      <span />
    </div>
  );
}

function Sidebar({ view, onChange, open, onClose, unreadCount }: { view: View; onChange: (view: View) => void; open: boolean; onClose: () => void; unreadCount: number }) {
  return (
    <aside className={`sidebar ${open ? "sidebar-open" : ""}`}>
      <div className="brand"><Logo /><span>DayDesk</span><button className="icon-button sidebar-close" onClick={onClose}><X size={19} /></button></div>
      <nav className="main-nav" aria-label="Главная навигация">
        {navItems.map(({ id, label, icon: Icon }) => (
          <button key={id} className={view === id ? "active" : ""} onClick={() => { onChange(id); onClose(); }}>
            <Icon size={19} strokeWidth={2} />
            <span>{label}</span>
            {id === "mail" && unreadCount > 0 ? <span className="nav-badge">{unreadCount}</span> : null}
          </button>
        ))}
      </nav>
      <div className="sidebar-label">МОИ СПИСКИ</div>
      <div className="lists">
        <button><span className="list-dot work" />Работа <span>5</span></button>
        <button><span className="list-dot personal" />Личное <span>3</span></button>
        <button><span className="list-dot health" />Здоровье <span>2</span></button>
        <button className="add-list"><Plus size={16} />Новый список</button>
      </div>
      <div className="sidebar-bottom">
        <div className="mini-profile"><div className="avatar">О</div><div><strong>Олег</strong><span>Всё синхронизировано</span></div><MoreHorizontal size={18} /></div>
        <button><Settings size={18} />Настройки</button>
      </div>
    </aside>
  );
}

function MiniCalendar({ events, selectedDate = new Date(), onSelect }: { events: CalendarEvent[]; selectedDate?: Date; onSelect?: (date: Date) => void }) {
  const now = new Date();
  const start = new Date(now);
  start.setDate(now.getDate() - 3);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
  return (
    <div className="week-strip">
      {days.map((day) => {
        const isSelected = sameDay(day, selectedDate);
        const hasEvents = events.some((event) => sameDay(new Date(event.startsAt), day));
        return <button key={day.toISOString()} className={isSelected ? "selected" : ""} onClick={() => onSelect?.(day)} aria-label={longDate(day)}><span>{weekday(day)}</span><strong>{day.getDate()}</strong>{hasEvents ? <i /> : null}</button>;
      })}
    </div>
  );
}

function TaskRow({ task, onToggle }: { task: Task; onToggle: (id: string) => void }) {
  return (
    <div className={`task-row ${task.completed ? "completed" : ""}`}>
      <button className="task-check" onClick={() => onToggle(task.id)} aria-label={task.completed ? "Вернуть задачу" : "Завершить задачу"}>
        {task.completed ? <Check size={14} /> : <Circle size={18} />}
      </button>
      <div className="task-copy"><strong>{task.title}</strong><span><Clock3 size={13} />{shortTime(task.dueAt)} · {task.category}</span></div>
      <span className={`priority ${task.priority}`} />
      <button className="icon-button"><MoreHorizontal size={18} /></button>
    </div>
  );
}

function EventIcon({ type }: { type: CalendarEvent["type"] }) {
  if (type === "meal") return <Utensils size={17} />;
  if (type === "focus") return <Sparkles size={17} />;
  if (type === "meeting") return <Video size={17} />;
  return <CalendarDays size={17} />;
}

function EventRow({ event, onEdit }: { event: CalendarEvent; onEdit?: (event: CalendarEvent) => void }) {
  return (
    <div className={`event-row event-${event.type}`}>
      <div className="event-time"><strong>{shortTime(event.startsAt)}</strong><span>{shortTime(event.endsAt)}</span></div>
      <div className="event-bar" />
      <div className="event-icon"><EventIcon type={event.type} /></div>
      <div className="event-copy"><strong>{event.title}</strong><span>{event.location ?? (event.type === "meal" ? "Перерыв" : "Личное время")}</span></div>
      <button className="icon-button event-menu" onClick={() => onEdit?.(event)} aria-label={`Изменить событие «${event.title}»`}><MoreHorizontal size={18} /></button>
    </div>
  );
}

function MailPreview({ state, setState, messages = state.messages, searchQuery = "", limit = 4, onShowAll, onOpen }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; messages?: MailMessage[]; searchQuery?: string; limit?: number; onShowAll?: () => void; onOpen?: (message: MailMessage) => void }) {
  const unread = messages.filter((message) => message.unread).length;
  const markRead = (id: string) => setState((current) => ({ ...current, messages: current.messages.map((message) => message.id === id ? { ...message, unread: false } : message) }));
  const searching = Boolean(searchQuery.trim());
  return (
    <section className="card mail-card">
      <div className="card-head"><div><span className="eyebrow"><Inbox size={15} />{searching ? "ПОИСК ПО ПОЧТЕ" : "ВХОДЯЩИЕ"}</span><h2>{searching ? "Результаты поиска" : "Свежая почта"} <span>{searching ? messages.length : unread}</span></h2></div>{onShowAll && !searching ? <button className="text-button" onClick={onShowAll}>Все письма <ChevronRight size={16} /></button> : null}</div>
      <div className="mail-list">
        {messages.length === 0 ? <div className="empty-state">{searching ? `По запросу «${searchQuery.trim()}» ничего не найдено.` : "Подключите почту, и свежие письма появятся здесь."}</div> : messages.slice(0, limit).map((message) => (
          <button className={`mail-row ${message.unread ? "unread" : ""}`} key={message.id} onClick={() => { markRead(message.id); onOpen?.(message); }}>
            <div className="sender-avatar" style={{ background: message.color }}>{message.initials}</div>
            <div className="mail-copy"><div><strong>{message.sender}</strong><time>{shortTime(message.receivedAt)}</time></div><b>{message.subject}</b><span>{message.preview}</span></div>
            {message.hasAttachments ? <Paperclip size={15} className="attachment-icon" /> : null}
            {message.starred ? <Star size={16} fill="#f8b84a" color="#f8b84a" /> : null}
            {message.unread ? <i className="unread-dot" /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function MailReader({ message, loading, error, downloadingAttachment, downloadStatus, onClose, onRetry, onDownload, onReply }: { message: MailMessage; loading: boolean; error: string; downloadingAttachment: string | null; downloadStatus: string; onClose: () => void; onRetry: () => void; onDownload: (attachment: MailAttachment) => void; onReply: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const received = new Intl.DateTimeFormat("ru-RU", { dateStyle: "long", timeStyle: "short" }).format(new Date(message.receivedAt));
  return (
    <div className="modal-backdrop mail-reader-backdrop" onMouseDown={onClose}>
      <article className="mail-reader" aria-labelledby="mail-reader-subject" onMouseDown={(event) => event.stopPropagation()}>
        <header className="mail-reader-header">
          <div className="sender-avatar mail-reader-avatar" style={{ background: message.color }}>{message.initials}</div>
          <div><strong>{message.sender}</strong><span>{received}</span></div>
          <button className="secondary-button mail-reader-reply" onClick={onReply}><Reply size={15} />Ответить</button>
          <button className="icon-button mail-reader-close" onClick={onClose} aria-label="Закрыть письмо"><X size={20} /></button>
        </header>
        <div className="mail-reader-title"><span className="eyebrow">ПИСЬМО</span><h2 id="mail-reader-subject">{message.subject}</h2>{message.hasAttachments ? <span className="attachment-chip"><Paperclip size={14} />{message.attachments?.length ? `${message.attachments.length} влож.` : "Есть вложения"}</span> : null}</div>
        <div className="mail-reader-content">
          {loading ? <div className="mail-reader-status"><LoaderCircle className="spin" size={22} />Загружаем защищённое содержимое…</div> : error ? <div className="mail-reader-status error"><span>{error}</span><button className="secondary-button" onClick={onRetry}>Повторить</button></div> : <div className="mail-reader-body">{message.body ?? message.preview}</div>}
          {!loading && !error && message.attachments?.length ? <div className="mail-attachments"><strong>Вложения</strong>{message.attachments.map((attachment) => <button key={attachment.id} disabled={!attachment.downloadable || downloadingAttachment !== null} onClick={() => onDownload(attachment)} title={attachment.downloadable ? "Сохранить в папку «Загрузки»" : "Это вложение нельзя скачать автоматически"}><span className="attachment-file"><Paperclip size={16} /></span><span><b>{attachment.name}</b><small>{fileSize(attachment.size)} · {attachment.mimeType}</small></span>{downloadingAttachment === attachment.id ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}</button>)}</div> : null}
          {downloadStatus ? <div className={`attachment-status ${downloadStatus.startsWith("Ошибка:") ? "error" : ""}`} role="status">{downloadStatus}</div> : null}
        </div>
        <footer className="mail-reader-footer"><ShieldCheck size={15} /><span>DayDesk показывает только безопасный текст. Скрипты, удалённые изображения и трекеры не загружаются.</span></footer>
      </article>
    </div>
  );
}

interface MailDraftSeed {
  to?: string;
  subject?: string;
  reply?: boolean;
}

const splitRecipients = (value: string) => value
  .split(/[;,]/)
  .map((address) => address.trim())
  .filter(Boolean);

const extractEmailAddress = (value: string) => {
  const angleAddress = value.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1];
  if (angleAddress) return angleAddress;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim() : "";
};

const smtpSettings = (account: MailAccount) => {
  if (account.smtpHost && account.smtpPort) return { host: account.smtpHost, port: account.smtpPort };
  const known: Record<string, { host: string; port: number }> = {
    "imap.yandex.ru": { host: "smtp.yandex.ru", port: 465 },
    "imap.mail.ru": { host: "smtp.mail.ru", port: 465 },
    "imap.mail.me.com": { host: "smtp.mail.me.com", port: 587 },
  };
  if (account.imapHost && known[account.imapHost]) return known[account.imapHost];
  return { host: account.imapHost?.replace(/^imap\./i, "smtp.") ?? "", port: 465 };
};

function MailComposer({ accounts, seed, onClose, onSent }: { accounts: MailAccount[]; seed?: MailDraftSeed; onClose: () => void; onSent: () => void }) {
  const [accountId, setAccountId] = useState(() => accounts[0]?.id ?? "");
  const [to, setTo] = useState(() => seed?.to ?? "");
  const [cc, setCc] = useState("");
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(() => seed?.subject ?? "");
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<SelectedMailAttachment[]>([]);
  const [choosingFiles, setChoosingFiles] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const selectedAccount = accounts.find((account) => account.id === accountId);

  const discardAttachments = useCallback((tokens: string[]) => {
    if (tokens.length > 0) void clearMailAttachments(tokens).catch(() => undefined);
  }, []);

  const close = useCallback(() => {
    discardAttachments(attachments.map((attachment) => attachment.token));
    onClose();
  }, [attachments, discardAttachments, onClose]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close, sending]);

  const chooseFiles = async () => {
    setChoosingFiles(true);
    setError("");
    try {
      const selected = await selectMailAttachments();
      const merged = [...attachments, ...selected];
      const total = merged.reduce((sum, attachment) => sum + attachment.size, 0);
      if (merged.length > 10 || total > 2 * 1024 * 1024) {
        discardAttachments(selected.map((attachment) => attachment.token));
        setError("Можно прикрепить до 10 файлов общим размером не больше 2 МБ");
        return;
      }
      setAttachments(merged);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось выбрать вложение");
    } finally {
      setChoosingFiles(false);
    }
  };

  const removeAttachment = (token: string) => {
    discardAttachments([token]);
    setAttachments((current) => current.filter((attachment) => attachment.token !== token));
  };

  const review = (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const recipients = [...splitRecipients(to), ...splitRecipients(cc), ...splitRecipients(bcc)];
    if (!selectedAccount) {
      setError("Выберите аккаунт отправителя");
      return;
    }
    if (splitRecipients(to).length === 0 || recipients.length > 25 || recipients.some((address) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) {
      setError("Проверьте адреса получателей. Разделяйте их запятыми");
      return;
    }
    if (subject.length > 500 || body.length > 200_000) {
      setError("Тема или текст письма превышают допустимый размер");
      return;
    }
    if (!body.trim() && attachments.length === 0) {
      setError("Добавьте текст или вложение");
      return;
    }
    setConfirming(true);
  };

  const deliver = async () => {
    if (!selectedAccount) return;
    setSending(true);
    setError("");
    const smtp = smtpSettings(selectedAccount);
    try {
      await sendMail({
        provider: selectedAccount.provider,
        accountId: selectedAccount.id,
        fromAddress: selectedAccount.address,
        smtpHost: selectedAccount.provider === "imap" ? smtp.host : undefined,
        smtpPort: selectedAccount.provider === "imap" ? smtp.port : undefined,
        to: splitRecipients(to),
        cc: splitRecipients(cc),
        bcc: splitRecipients(bcc),
        subject: subject.trim(),
        body,
        attachmentTokens: attachments.map((attachment) => attachment.token),
      });
      onSent();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отправить письмо");
      setConfirming(false);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="modal-backdrop mail-reader-backdrop" onMouseDown={close}>
      <form className="mail-composer" aria-labelledby="mail-composer-title" onSubmit={review} onMouseDown={(event) => event.stopPropagation()}>
        <header className="composer-header"><div><span className="eyebrow">ИСХОДЯЩЕЕ ПИСЬМО</span><h2 id="mail-composer-title">{seed?.reply ? "Ответить" : "Новое письмо"}</h2></div><button type="button" className="icon-button mail-reader-close" onClick={close} aria-label="Закрыть редактор"><X size={20} /></button></header>
        {confirming ? <div className="composer-confirmation">
          <div className="confirmation-icon"><Send size={24} /></div>
          <span className="eyebrow">ПРОВЕРКА ПЕРЕД ОТПРАВКОЙ</span>
          <h3>Отправить это письмо?</h3>
          <dl><div><dt>От кого</dt><dd>{selectedAccount?.address}</dd></div><div><dt>Кому</dt><dd>{splitRecipients(to).join(", ")}</dd></div><div><dt>Тема</dt><dd>{subject.trim() || "Без темы"}</dd></div><div><dt>Вложения</dt><dd>{attachments.length ? `${attachments.length}, ${fileSize(attachments.reduce((sum, attachment) => sum + attachment.size, 0))}` : "Нет"}</dd></div></dl>
          <div className="security-note"><ShieldCheck size={17} /><span>После подтверждения DayDesk сразу передаст письмо выбранному почтовому сервису. Отменить отправку после этого нельзя.</span></div>
          {error ? <div className="form-error" role="alert">{error}</div> : null}
          <div className="composer-actions"><button type="button" className="secondary-button" disabled={sending} onClick={() => setConfirming(false)}>Вернуться</button><button type="button" className="primary-button" disabled={sending} onClick={() => void deliver()}>{sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}{sending ? "Отправляем…" : "Да, отправить"}</button></div>
        </div> : <>
          <div className="composer-fields">
            <label>От кого<select value={accountId} onChange={(event) => setAccountId(event.target.value)}>{accounts.map((account) => <option key={account.id} value={account.id}>{account.label} · {account.address}</option>)}</select></label>
            <label>Кому<input autoFocus value={to} maxLength={4000} onChange={(event) => setTo(event.target.value)} placeholder="name@example.com" /></label>
            <div className="composer-copy-fields"><label>Копия<input value={cc} maxLength={4000} onChange={(event) => setCc(event.target.value)} placeholder="Необязательно" /></label><label>Скрытая копия<input value={bcc} maxLength={4000} onChange={(event) => setBcc(event.target.value)} placeholder="Необязательно" /></label></div>
            <label>Тема<input value={subject} maxLength={500} onChange={(event) => setSubject(event.target.value)} placeholder="О чём письмо" /></label>
            <label className="composer-body-label">Текст<textarea value={body} maxLength={200000} onChange={(event) => setBody(event.target.value)} placeholder="Напишите сообщение…" /></label>
          </div>
          <div className="composer-attachments"><div><strong>Вложения</strong><span>До 10 файлов, всего не больше 2 МБ</span></div><button type="button" className="secondary-button" disabled={choosingFiles} onClick={() => void chooseFiles()}>{choosingFiles ? <LoaderCircle className="spin" size={16} /> : <FilePlus2 size={16} />}Прикрепить</button>{attachments.length ? <div className="composer-file-list">{attachments.map((attachment) => <div key={attachment.token}><Paperclip size={15} /><span><b>{attachment.name}</b><small>{fileSize(attachment.size)} · {attachment.mimeType}</small></span><button type="button" className="icon-button" onClick={() => removeAttachment(attachment.token)} aria-label={`Убрать ${attachment.name}`}><X size={15} /></button></div>)}</div> : null}</div>
          {error ? <div className="form-error composer-error" role="alert">{error}</div> : null}
          <footer className="composer-footer"><span>Черновик хранится только до закрытия окна</span><button className="primary-button"><Send size={17} />Проверить и отправить</button></footer>
        </>}
      </form>
    </div>
  );
}

function AddTask({ onAdd, onClose }: { onAdd: (title: string, time: string) => void; onClose: () => void }) {
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("18:00");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    onAdd(title.trim(), time);
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="quick-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><ListTodo size={22} /></div>
        <div><span className="eyebrow">НОВАЯ ЗАДАЧА</span><h2>Что нужно сделать?</h2></div>
        <button type="button" className="icon-button modal-close" onClick={onClose}><X size={20} /></button>
        <label>Название<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, позвонить врачу" /></label>
        <label>Напомнить<input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label>
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button"><Plus size={17} />Добавить</button></div>
      </form>
    </div>
  );
}

function EventEditor({ existing, onSave, onDelete, onClose }: { existing?: CalendarEvent; onSave: (event: CalendarEvent) => void; onDelete: (id: string) => void; onClose: () => void }) {
  const defaults = useMemo(() => {
    const start = new Date();
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() + 1);
    const end = new Date(start.getTime() + 60 * 60_000);
    return { start: start.toISOString(), end: end.toISOString() };
  }, []);
  const [title, setTitle] = useState(() => existing?.title ?? "");
  const [date, setDate] = useState(() => inputDate(existing?.startsAt ?? defaults.start));
  const [startsAt, setStartsAt] = useState(() => inputTime(existing?.startsAt ?? defaults.start));
  const [endsAt, setEndsAt] = useState(() => inputTime(existing?.endsAt ?? defaults.end));
  const [type, setType] = useState<CalendarEvent["type"]>(() => existing?.type ?? "meeting");
  const [location, setLocation] = useState(() => existing?.location ?? "");
  const [reminder, setReminder] = useState(() => existing?.remindBeforeMinutes ?? 10);
  const [error, setError] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!title.trim()) return;
    const start = combineDateTime(date, startsAt);
    const end = combineDateTime(date, endsAt);
    if (new Date(end) <= new Date(start)) {
      setError("Время окончания должно быть позже начала");
      return;
    }
    onSave({ id: existing?.id ?? uid(), title: title.trim(), startsAt: start, endsAt: end, type, location: location.trim() || undefined, remindBeforeMinutes: reminder });
  };

  const remove = () => {
    if (!existing || !window.confirm(`Удалить событие «${existing.title}»?`)) return;
    onDelete(existing.id);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="quick-modal event-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><CalendarDays size={22} /></div>
        <div><span className="eyebrow">{existing ? "РЕДАКТИРОВАНИЕ" : "НОВОЕ СОБЫТИЕ"}</span><h2>{existing ? "Изменить событие" : "Добавить в расписание"}</h2></div>
        <button type="button" className="icon-button modal-close" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        <div className="form-grid">
          <label className="field-full">Название<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Например, встреча с командой" /></label>
          <label>Тип<select value={type} onChange={(event) => setType(event.target.value as CalendarEvent["type"])}><option value="meeting">Встреча</option><option value="meal">Обед или ужин</option><option value="focus">Фокус-время</option><option value="personal">Личное</option></select></label>
          <label>Дата<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label>
          <label>Начало<input type="time" value={startsAt} onChange={(event) => { setStartsAt(event.target.value); setError(""); }} /></label>
          <label>Окончание<input type="time" value={endsAt} onChange={(event) => { setEndsAt(event.target.value); setError(""); }} /></label>
          <label className="field-full">Место или ссылка<input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="Необязательно" /></label>
          <label className="field-full">Напомнить<select value={reminder} onChange={(event) => setReminder(Number(event.target.value))}><option value={0}>Не напоминать</option><option value={5}>За 5 минут</option><option value={10}>За 10 минут</option><option value={15}>За 15 минут</option><option value={30}>За 30 минут</option><option value={60}>За 1 час</option></select></label>
        </div>
        {error ? <div className="form-error">{error}</div> : null}
        <div className="modal-actions event-actions">{existing ? <button type="button" className="danger-button" onClick={remove}><Trash2 size={16} />Удалить</button> : null}<span /><button type="button" className="secondary-button" onClick={onClose}>Отмена</button><button className="primary-button"><Check size={17} />Сохранить</button></div>
      </form>
    </div>
  );
}

function TodayView({ state, setState, onAddTask, onAddEvent, onEditEvent }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; onAddTask: () => void; onAddEvent: () => void; onEditEvent: (event: CalendarEvent) => void }) {
  const now = useClock();
  const greeting = now.getHours() < 12 ? "Доброе утро" : now.getHours() < 18 ? "Добрый день" : "Добрый вечер";
  const completed = state.tasks.filter((task) => task.completed).length;
  const progress = state.tasks.length ? Math.round((completed / state.tasks.length) * 100) : 0;
  const todayEvents = state.events.filter((event) => sameDay(new Date(event.startsAt), now)).sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const toggleTask = (id: string) => setState((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task) }));
  return (
    <>
      <div className="welcome-row"><div><p>{longDate(now)}</p><h1>{greeting}, Олег <span>👋</span></h1><span>Спокойный день начинается с ясного плана.</span></div><div className="weather"><div>☀️</div><strong>+18°</strong><span>Москва</span></div></div>
      <MiniCalendar events={state.events} selectedDate={now} />
      <div className="dashboard-grid">
        <section className="card tasks-card">
          <div className="card-head"><div><span className="eyebrow"><CheckCircle2 size={15} />ЗАДАЧИ</span><h2>На сегодня <span>{state.tasks.filter((task) => !task.completed).length}</span></h2></div><div className="progress-ring" style={{ "--progress": `${progress * 3.6}deg` } as React.CSSProperties}><span>{progress}%</span></div></div>
          <div className="task-list">{state.tasks.map((task) => <TaskRow key={task.id} task={task} onToggle={toggleTask} />)}</div>
          <button className="add-row" onClick={onAddTask}><Plus size={17} />Добавить задачу</button>
        </section>
        <section className="card schedule-card">
          <div className="card-head"><div><span className="eyebrow"><CalendarDays size={15} />РАСПИСАНИЕ</span><h2>Ближайшее</h2></div><button className="date-chip">Сегодня <ChevronDown size={14} /></button></div>
          <div className="event-list">{todayEvents.length ? todayEvents.slice(0, 4).map((event) => <EventRow key={event.id} event={event} onEdit={onEditEvent} />) : <div className="empty-state">На сегодня событий нет</div>}</div>
          <button className="add-row" onClick={onAddEvent}><Plus size={17} />Добавить событие</button>
        </section>
      </div>
      <MailPreview state={state} setState={setState} />
    </>
  );
}

function TasksView({ state, setState, onAdd }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; onAdd: () => void }) {
  const toggle = (id: string) => setState((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, completed: !task.completed } : task) }));
  return <section className="page-section"><div className="page-title"><div><span className="eyebrow">МОЙ ДЕНЬ</span><h1>Задачи</h1><p>Соберите всё важное в одном спокойном списке.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} />Новая задача</button></div><div className="card large-list">{state.tasks.map((task) => <TaskRow key={task.id} task={task} onToggle={toggle} />)}<button className="add-row" onClick={onAdd}><Plus size={17} />Добавить задачу</button></div></section>;
}

function CalendarView({ events, onAdd, onEdit }: { events: CalendarEvent[]; onAdd: () => void; onEdit: (event: CalendarEvent) => void }) {
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const selectedEvents = useMemo(() => events.filter((event) => sameDay(new Date(event.startsAt), selectedDate)).sort((left, right) => left.startsAt.localeCompare(right.startsAt)), [events, selectedDate]);
  return <section className="page-section"><div className="page-title"><div><span className="eyebrow">ПЛАН НА ДЕНЬ</span><h1>Календарь</h1><p>Встречи, питание и фокус-время без накладок.</p></div><button className="primary-button" onClick={onAdd}><Plus size={17} />Новое событие</button></div><MiniCalendar events={events} selectedDate={selectedDate} onSelect={setSelectedDate} /><div className="calendar-date-title"><strong>{longDate(selectedDate)}</strong><span>{selectedEvents.length} {selectedEvents.length === 1 ? "событие" : selectedEvents.length > 1 && selectedEvents.length < 5 ? "события" : "событий"}</span></div><div className="card calendar-list">{selectedEvents.length ? selectedEvents.map((event) => <EventRow key={event.id} event={event} onEdit={onEdit} />) : <div className="empty-state large">Свободный день — можно запланировать отдых или фокус-время.</div>}</div></section>;
}

const mailPresets = [
  { label: "Yandex", host: "imap.yandex.ru", smtpHost: "smtp.yandex.ru", smtpPort: 465 },
  { label: "Mail.ru", host: "imap.mail.ru", smtpHost: "smtp.mail.ru", smtpPort: 465 },
  { label: "iCloud", host: "imap.mail.me.com", smtpHost: "smtp.mail.me.com", smtpPort: 587 },
];

const senderInitials = (sender: string) => sender
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0]?.toUpperCase())
  .join("") || "@";

function toMailMessages(account: MailAccount, messages: RemoteMailMessage[]): MailMessage[] {
  return messages.map((message) => ({
    ...message,
    id: `${account.id}:${message.id}`,
    accountId: account.id,
    initials: senderInitials(message.sender),
    starred: false,
    color: account.color,
  }));
}

function mergeAccountMessages(current: MailMessage[], accountId: string, fresh: MailMessage[]) {
  const previous = new Map(current.filter((message) => message.accountId === accountId).map((message) => [message.id, message]));
  const merged = fresh.map((message) => {
    const existing = previous.get(message.id);
    if (!existing) return message;
    return {
      ...message,
      unread: existing.unread ? message.unread : false,
      starred: existing.starred,
    };
  });
  return [...merged, ...current.filter((message) => message.accountId !== accountId)]
    .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt));
}

function MailConnectModal({ onConnected, onClose }: { onConnected: (account: MailAccount, messages: MailMessage[]) => void; onClose: () => void }) {
  const [label, setLabel] = useState("Личная почта");
  const [address, setAddress] = useState("");
  const [host, setHost] = useState("imap.yandex.ru");
  const [smtpHost, setSmtpHost] = useState("smtp.yandex.ru");
  const [smtpPort, setSmtpPort] = useState(465);
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const close = () => {
    setPassword("");
    onClose();
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    const normalizedAddress = address.trim();
    const normalizedHost = host.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedAddress)) {
      setError("Укажите полный адрес электронной почты");
      return;
    }
    if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(normalizedHost)) {
      setError("Укажите корректный адрес IMAP-сервера");
      return;
    }
    const normalizedSmtpHost = smtpHost.trim().toLowerCase();
    if (!/^(?=.{1,253}$)[a-z0-9.-]+$/.test(normalizedSmtpHost) || ![465, 587].includes(smtpPort)) {
      setError("Укажите защищённый SMTP-сервер и порт 465 или 587");
      return;
    }
    if (!password || password.length > 1024) {
      setError("Введите пароль приложения от почтового ящика");
      return;
    }

    const account: MailAccount = {
      id: `mail_${uid().replace(/[^a-zA-Z0-9_-]/g, "")}`,
      provider: "imap",
      label: label.trim() || normalizedAddress,
      address: normalizedAddress,
      connected: true,
      color: "#7868f1",
      imapHost: normalizedHost,
      imapPort: 993,
      smtpHost: normalizedSmtpHost,
      smtpPort,
      authType: "password",
      lastSyncedAt: new Date().toISOString(),
    };

    setLoading(true);
    try {
      const loaded = await connectImap({
        accountId: account.id,
        host: normalizedHost,
        port: 993,
        username: normalizedAddress,
        password,
      });
      setPassword("");
      onConnected(account, toMailMessages(account, loaded));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключить почту");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form className="quick-modal mail-connect-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-icon"><LockKeyhole size={22} /></div>
        <div><span className="eyebrow">ЗАЩИЩЁННЫЙ IMAP</span><h2>Подключить почту</h2></div>
        <button type="button" className="icon-button modal-close" onClick={close}><X size={20} /></button>
        <div className="mail-presets" aria-label="Популярные почтовые серверы">
          {mailPresets.map((preset) => <button type="button" className={host === preset.host ? "active" : ""} key={preset.host} onClick={() => { setHost(preset.host); setSmtpHost(preset.smtpHost); setSmtpPort(preset.smtpPort); }}>{preset.label}</button>)}
        </div>
        <div className="form-grid">
          <label>Название аккаунта<input value={label} autoComplete="off" maxLength={80} onChange={(event) => setLabel(event.target.value)} placeholder="Например, Рабочая" /></label>
          <label>Адрес почты<input autoFocus type="email" autoComplete="username" value={address} maxLength={320} onChange={(event) => setAddress(event.target.value)} placeholder="name@example.com" /></label>
          <label className="field-full">IMAP-сервер<input value={host} autoComplete="off" maxLength={253} onChange={(event) => setHost(event.target.value)} placeholder="imap.example.com" /></label>
          <label>SMTP-сервер<input value={smtpHost} autoComplete="off" maxLength={253} onChange={(event) => setSmtpHost(event.target.value)} placeholder="smtp.example.com" /></label>
          <label>SMTP TLS-порт<select value={smtpPort} onChange={(event) => setSmtpPort(Number(event.target.value))}><option value={465}>465 · SMTPS</option><option value={587}>587 · STARTTLS</option></select></label>
          <label className="field-full">Пароль приложения<input type="password" autoComplete="current-password" value={password} maxLength={1024} onChange={(event) => setPassword(event.target.value)} placeholder="Не обычный пароль, если включена 2FA" /></label>
        </div>
        <div className="security-note"><ShieldCheck size={17} /><span>Пароль передаётся только IMAP-серверу по TLS и хранится в системном хранилище macOS или Windows. DayDesk его не записывает в данные приложения.</span></div>
        {error ? <div className="form-error" role="alert">{error}</div> : null}
        <div className="modal-actions"><button type="button" className="secondary-button" onClick={close}>Отмена</button><button className="primary-button" disabled={loading}>{loading ? <LoaderCircle className="spin" size={17} /> : <Server size={17} />}{loading ? "Проверяем…" : "Подключить"}</button></div>
      </form>
    </div>
  );
}

function MailView({ state, setState, searchQuery }: { state: AppState; setState: React.Dispatch<React.SetStateAction<AppState>>; searchQuery: string }) {
  const [showConnector, setShowConnector] = useState(false);
  const [composerSeed, setComposerSeed] = useState<MailDraftSeed | null>(null);
  const [mailActionStatus, setMailActionStatus] = useState("");
  const [workingAccount, setWorkingAccount] = useState<string | null>(null);
  const [workingProvider, setWorkingProvider] = useState<OAuthProvider | null>(null);
  const [oauthStatus, setOauthStatus] = useState<OAuthProviderStatus | null>(null);
  const [error, setError] = useState("");
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null);
  const [readerLoading, setReaderLoading] = useState(false);
  const [readerError, setReaderError] = useState("");
  const [downloadingAttachment, setDownloadingAttachment] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState("");
  const readerRequest = useRef(0);
  const [cachedSearchResults, setCachedSearchResults] = useState<MailMessage[] | null>(null);
  const deferredSearchQuery = useDeferredValue(searchQuery.trim());
  const localSearchResults = useMemo(() => {
    const normalized = deferredSearchQuery.toLocaleLowerCase("ru-RU");
    if (!normalized) return state.messages;
    return state.messages.filter((message) => [message.sender, message.subject, message.preview]
      .some((value) => value.toLocaleLowerCase("ru-RU").includes(normalized)));
  }, [deferredSearchQuery, state.messages]);

  useEffect(() => {
    if (!deferredSearchQuery) {
      setCachedSearchResults(null);
      return;
    }
    let active = true;
    setCachedSearchResults(null);
    const timer = window.setTimeout(() => {
      void searchMailCache(deferredSearchQuery, 100)
        .then((messages) => { if (active && messages !== null) setCachedSearchResults(messages); })
        .catch(() => { if (active) setCachedSearchResults(null); });
    }, 180);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [deferredSearchQuery, state.messages]);

  useEffect(() => {
    let active = true;
    void getOAuthProviderStatus()
      .then((status) => { if (active) setOauthStatus(status); })
      .catch(() => { if (active) setOauthStatus({ gmail: false, outlook: false }); });
    return () => { active = false; };
  }, []);

  const connected = (account: MailAccount, messages: MailMessage[]) => {
    setState((current) => ({
      ...current,
      accounts: [...current.accounts.filter((item) => item.id !== account.id), account],
      messages: mergeAccountMessages(current.messages, account.id, messages),
    }));
    setShowConnector(false);
  };

  const connectOAuthAccount = async (provider: OAuthProvider) => {
    setError("");
    setWorkingProvider(provider);
    const accountId = `mail_${uid().replace(/[^a-zA-Z0-9_-]/g, "")}`;
    try {
      const result = await connectOAuth({ provider, accountId });
      const account: MailAccount = {
        id: accountId,
        provider,
        label: result.label || (provider === "gmail" ? "Gmail" : "Outlook"),
        address: result.address,
        connected: true,
        color: provider === "gmail" ? "#e95c55" : "#3478f6",
        authType: "oauth",
        lastSyncedAt: new Date().toISOString(),
      };
      connected(account, toMailMessages(account, result.messages));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось подключить аккаунт");
    } finally {
      setWorkingProvider(null);
    }
  };

  const synchronize = async (account: MailAccount) => {
    const imapHost = account.imapHost;
    if (account.authType !== "oauth" && !imapHost) return;
    setError("");
    setWorkingAccount(account.id);
    try {
      const loaded = account.authType === "oauth"
        ? await syncOAuth({ provider: account.provider as OAuthProvider, accountId: account.id })
        : await syncImap({ accountId: account.id, host: imapHost ?? "", port: account.imapPort ?? 993, username: account.address });
      const messages = toMailMessages(account, loaded);
      setState((current) => ({
        ...current,
        accounts: current.accounts.map((item) => item.id === account.id ? { ...item, lastSyncedAt: new Date().toISOString() } : item),
        messages: mergeAccountMessages(current.messages, account.id, messages),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось обновить почту");
    } finally {
      setWorkingAccount(null);
    }
  };

  const disconnect = async (account: MailAccount) => {
    if (!window.confirm(`Отключить ${account.address} и удалить данные входа из системного хранилища?`)) return;
    setError("");
    setWorkingAccount(account.id);
    try {
      if (account.authType === "oauth") {
        await disconnectOAuth({ provider: account.provider as OAuthProvider, accountId: account.id });
      } else {
        await disconnectImap(account.id);
      }
      setState((current) => ({
        ...current,
        accounts: current.accounts.filter((item) => item.id !== account.id),
        messages: current.messages.filter((message) => message.accountId !== account.id),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось отключить почту");
    } finally {
      setWorkingAccount(null);
    }
  };

  const openMessage = (requestedMessage: MailMessage) => {
    const message = state.messages.find((item) => item.id === requestedMessage.id) ?? requestedMessage;
    setSelectedMessageId(message.id);
    setReaderError("");
    setDownloadStatus("");
    if (message.body !== undefined) {
      setReaderLoading(false);
      return;
    }
    const account = state.accounts.find((item) => item.id === message.accountId);
    const prefix = `${message.accountId}:`;
    const remoteMessageId = message.id.startsWith(prefix) ? message.id.slice(prefix.length) : "";
    if (!account || !remoteMessageId) {
      setReaderError("Не удалось определить почтовый аккаунт для этого письма");
      setReaderLoading(false);
      return;
    }
    const requestId = ++readerRequest.current;
    setReaderLoading(true);
    void (account.authType === "oauth"
      ? getOAuthMessageContent({ provider: account.provider as OAuthProvider, accountId: account.id, messageId: remoteMessageId })
      : getImapMessageContent({ accountId: account.id, host: account.imapHost ?? "", port: account.imapPort ?? 993, username: account.address, messageId: remoteMessageId }))
      .then((content) => {
        setState((current) => ({ ...current, messages: current.messages.map((item) => item.id === message.id ? { ...item, body: content.body, hasAttachments: content.hasAttachments, attachments: content.attachments } : item) }));
        if (readerRequest.current === requestId) setReaderError("");
      })
      .catch((reason) => {
        if (readerRequest.current === requestId) setReaderError(reason instanceof Error ? reason.message : "Не удалось загрузить письмо");
      })
      .finally(() => { if (readerRequest.current === requestId) setReaderLoading(false); });
  };

  const closeMessage = useCallback(() => {
    readerRequest.current += 1;
    setSelectedMessageId(null);
    setReaderLoading(false);
    setReaderError("");
    setDownloadingAttachment(null);
    setDownloadStatus("");
  }, []);

  const downloadAttachment = (message: MailMessage, attachment: MailAttachment) => {
    const account = state.accounts.find((item) => item.id === message.accountId);
    const prefix = `${message.accountId}:`;
    const remoteMessageId = message.id.startsWith(prefix) ? message.id.slice(prefix.length) : "";
    if (!account || !remoteMessageId || !attachment.downloadable) {
      setDownloadStatus("Ошибка: вложение нельзя скачать автоматически");
      return;
    }
    setDownloadingAttachment(attachment.id);
    setDownloadStatus("");
    void (account.authType === "oauth"
      ? downloadOAuthAttachment({ provider: account.provider as OAuthProvider, accountId: account.id, messageId: remoteMessageId, attachmentId: attachment.id })
      : downloadImapAttachment({ accountId: account.id, host: account.imapHost ?? "", port: account.imapPort ?? 993, username: account.address, messageId: remoteMessageId, attachmentId: attachment.id }))
      .then((result) => setDownloadStatus(`Сохранено в «Загрузки»: ${result.fileName}`))
      .catch((reason) => setDownloadStatus(`Ошибка: ${reason instanceof Error ? reason.message : "не удалось сохранить вложение"}`))
      .finally(() => setDownloadingAttachment(null));
  };

  const selectedMessage = selectedMessageId ? state.messages.find((message) => message.id === selectedMessageId) : undefined;

  const replyToMessage = (message: MailMessage) => {
    closeMessage();
    const address = extractEmailAddress(message.sender);
    setComposerSeed({
      to: address,
      subject: /^re:/i.test(message.subject) ? message.subject : `Re: ${message.subject}`,
      reply: true,
    });
  };

  return (
    <section className="page-section">
      <div className="page-title"><div><span className="eyebrow">ЕДИНЫЙ ЯЩИК</span><h1>Почта</h1><p>Все письма в одном месте — без хранения паролей внутри DayDesk.</p></div><div className="mail-title-actions"><button className="secondary-button" disabled={state.accounts.length === 0} onClick={() => setComposerSeed({})}><Send size={17} />Написать</button><button className="primary-button" onClick={() => setShowConnector(true)}><Plus size={17} />Подключить почту</button></div></div>
      <div className="provider-grid">
        <button className="card provider-card provider-action" disabled={workingProvider !== null} onClick={() => void connectOAuthAccount("gmail")}><div className="provider-logo gmail">M</div><div><strong>Gmail</strong><span>Безопасный вход Google</span></div><em>{workingProvider === "gmail" ? <><LoaderCircle className="spin" size={12} />Ожидаем вход…</> : oauthStatus === null ? "Проверяем доступность…" : oauthStatus.gmail ? "Подключить через Google" : "Требуется настройка OAuth"}</em></button>
        <button className="card provider-card provider-action" disabled={workingProvider !== null} onClick={() => void connectOAuthAccount("outlook")}><div className="provider-logo outlook">O</div><div><strong>Outlook / 365</strong><span>Вход Microsoft</span></div><em>{workingProvider === "outlook" ? <><LoaderCircle className="spin" size={12} />Ожидаем вход…</> : oauthStatus === null ? "Проверяем доступность…" : oauthStatus.outlook ? "Подключить через Microsoft" : "Требуется настройка OAuth"}</em></button>
        <button className="card provider-card provider-action" onClick={() => setShowConnector(true)}><div className="provider-logo imap">@</div><div><strong>IMAP-почта</strong><span>Yandex, Mail.ru, iCloud и другие</span></div><em>Подключить сейчас</em></button>
      </div>
      {state.accounts.length > 0 ? <><div className="mail-section-title"><strong>Подключённые аккаунты</strong><span>{state.accounts.length}</span></div><div className="account-grid">{state.accounts.map((account) => <div className="card account-card connected-account" key={account.id}><div className={`provider-logo ${account.provider}`}>{account.provider === "gmail" ? "M" : account.provider === "outlook" ? "O" : "@"}</div><div><strong>{account.label}</strong><span>{account.address}</span></div><div className="account-actions"><button className="icon-button" disabled={workingAccount === account.id} onClick={() => void synchronize(account)} title="Обновить письма">{workingAccount === account.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</button><button className="disconnect-button" disabled={workingAccount === account.id} onClick={() => void disconnect(account)}>Отключить</button></div></div>)}</div></> : null}
      {error ? <div className="form-error mail-error" role="alert">{error}</div> : null}
      {mailActionStatus ? <div className="mail-action-status" role="status"><CheckCircle2 size={16} />{mailActionStatus}</div> : null}
      <MailPreview state={state} setState={setState} messages={deferredSearchQuery ? cachedSearchResults ?? localSearchResults : state.messages} searchQuery={deferredSearchQuery} limit={100} onOpen={openMessage} />
      {showConnector ? <MailConnectModal onConnected={connected} onClose={() => setShowConnector(false)} /> : null}
      {selectedMessage ? <MailReader message={selectedMessage} loading={readerLoading} error={readerError} downloadingAttachment={downloadingAttachment} downloadStatus={downloadStatus} onClose={closeMessage} onRetry={() => openMessage(selectedMessage)} onDownload={(attachment) => downloadAttachment(selectedMessage, attachment)} onReply={() => replyToMessage(selectedMessage)} /> : null}
      {composerSeed ? <MailComposer accounts={state.accounts} seed={composerSeed} onClose={() => setComposerSeed(null)} onSent={() => { setComposerSeed(null); setMailActionStatus("Письмо принято почтовым сервисом и отправляется"); }} /> : null}
    </section>
  );
}

async function openWidget() {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const existing = await WebviewWindow.getByLabel("agenda-widget");
    if (existing) { await existing.show(); await existing.setFocus(); return; }
    new WebviewWindow("agenda-widget", { url: "/?widget=agenda", title: "DayDesk — Сегодня", width: 360, height: 510, decorations: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnBottom: true, shadow: true });
  } catch {
    window.open("/?widget=agenda", "daydesk-widget", "width=360,height=510");
  }
}

function WidgetsView() {
  return <section className="page-section"><div className="page-title"><div><span className="eyebrow">РАБОЧИЙ СТОЛ</span><h1>Виджеты</h1><p>Важное остаётся перед глазами, не мешая работе.</p></div></div><div className="widget-gallery"><div className="card widget-option"><div className="widget-preview"><div className="preview-top"><Logo /><span>Сегодня</span><MoreHorizontal size={14} /></div><strong>4 задачи</strong><div className="preview-line"><i />Презентация <span>11:30</span></div><div className="preview-line"><i />Встреча с Анной <span>15:00</span></div><div className="preview-line"><i />Заказать продукты <span>18:30</span></div></div><div className="widget-description"><div><h3>План на сегодня</h3><p>Задачи и ближайшие события</p></div><button className="primary-button" onClick={openWidget}><Plus size={17} />На рабочий стол</button></div></div><div className="card widget-option coming"><div className="coming-visual"><Clock3 size={42} /><Coffee size={28} /></div><div className="widget-description"><div><h3>Ритм дня</h3><p>Вода, обед, отдых и фокус</p></div><span>Скоро</span></div></div></div></section>;
}

function WidgetApp({ state }: { state: AppState }) {
  const now = useClock();
  const upcoming = state.tasks.filter((task) => !task.completed).slice(0, 4);
  return <main className="desktop-widget"><div className="widget-drag" data-tauri-drag-region><Logo /><span data-tauri-drag-region>Сегодня</span><button className="icon-button"><MoreHorizontal size={17} /></button></div><div className="widget-date"><span>{longDate(now)}</span><strong>{new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(now)}</strong></div><div className="widget-stat"><div><CheckCircle2 size={20} /><strong>{upcoming.length}</strong><span>осталось</span></div><div><CalendarDays size={20} /><strong>{state.events.length}</strong><span>событий</span></div></div><div className="widget-tasks">{upcoming.map((task) => <div key={task.id}><Circle size={17} /><span>{task.title}</span><time>{shortTime(task.dueAt)}</time></div>)}</div><button className="widget-add"><Plus size={17} />Добавить задачу</button></main>;
}

export default function App() {
  const isWidget = new URLSearchParams(window.location.search).get("widget") === "agenda";
  const [state, setState] = useState<AppState>(() => loadState());
  const [view, setView] = useState<View>("today");
  const [adding, setAdding] = useState(false);
  const [eventEditor, setEventEditor] = useState<CalendarEvent | "new" | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [mailCacheReady, setMailCacheReady] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const notifiedEvents = useRef(new Set<string>());
  const mailSyncRunning = useRef(false);
  const mailAccountsKey = state.accounts
    .map((account) => [account.id, account.provider, account.authType, account.address, account.imapHost ?? "", account.imapPort ?? ""].join(":"))
    .join("|");

  useEffect(() => {
    saveState(state);
    stateChannel?.postMessage({ ...state, messages: [] });
  }, [state]);

  useEffect(() => {
    if (isWidget) return;
    let active = true;
    void loadMailCache()
      .then((messages) => {
        if (!active) return;
        setState((current) => {
          const accountIds = new Set(current.accounts.map((account) => account.id));
          const cached = messages.filter((message) => accountIds.has(message.accountId));
          return cached.length > 0 ? { ...current, messages: cached } : current;
        });
        setMailCacheReady(true);
      })
      .catch(() => { /* Не перезаписываем кэш, если системное хранилище недоступно. */ });
    return () => { active = false; };
  }, [isWidget]);

  useEffect(() => {
    if (isWidget || !mailCacheReady) return;
    const timer = window.setTimeout(() => void replaceMailCache(state.messages).catch(() => undefined), 250);
    return () => window.clearTimeout(timer);
  }, [isWidget, mailCacheReady, state.messages]);

  useEffect(() => {
    if (isWidget) return;
    const focusSearch = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [isWidget]);

  useEffect(() => {
    if (!stateChannel) return;
    const channel = stateChannel;
    const receive = (event: MessageEvent<AppState>) => setState((current) =>
      JSON.stringify(current) === JSON.stringify(event.data) ? current : event.data,
    );
    channel.addEventListener("message", receive);
    return () => channel.removeEventListener("message", receive);
  }, []);

  useEffect(() => {
    const check = () => {
      const current = Date.now();
      for (const event of state.events) {
        if (event.remindBeforeMinutes <= 0) continue;
        const until = new Date(event.startsAt).getTime() - current;
        const notificationKey = `${event.id}:${event.startsAt}`;
        if (until > 0 && until <= event.remindBeforeMinutes * 60_000 && !notifiedEvents.current.has(notificationKey)) {
          notifiedEvents.current.add(notificationKey);
          void notify(`Через ${Math.max(1, Math.round(until / 60_000))} мин: ${event.title}`, event.location ?? "DayDesk напомнит вовремя");
        }
      }
    };
    check();
    const timer = window.setInterval(check, 60_000);
    return () => window.clearInterval(timer);
  }, [state.events]);

  useEffect(() => {
    if (isWidget || !mailAccountsKey) return;
    let cancelled = false;
    const accounts = state.accounts;
    const synchronizeAll = async () => {
      if (mailSyncRunning.current) return;
      mailSyncRunning.current = true;
      try {
        const results = await Promise.allSettled(accounts.map(async (account) => {
          const loaded = account.authType === "oauth"
            ? await syncOAuth({ provider: account.provider as OAuthProvider, accountId: account.id })
            : account.imapHost
              ? await syncImap({ accountId: account.id, host: account.imapHost, port: account.imapPort ?? 993, username: account.address })
              : [];
          return { account, messages: toMailMessages(account, loaded) };
        }));
        if (cancelled) return;
        const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
        if (successful.length === 0) return;
        const syncedAt = new Date().toISOString();
        const syncedIds = new Set(successful.map(({ account }) => account.id));
        setState((current) => {
          let messages = current.messages;
          for (const result of successful) {
            messages = mergeAccountMessages(messages, result.account.id, result.messages);
          }
          return {
            ...current,
            accounts: current.accounts.map((account) => syncedIds.has(account.id) ? { ...account, lastSyncedAt: syncedAt } : account),
            messages,
          };
        });
      } finally {
        mailSyncRunning.current = false;
      }
    };
    const initialTimer = window.setTimeout(() => void synchronizeAll(), 15_000);
    const interval = window.setInterval(() => void synchronizeAll(), 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
    };
  }, [isWidget, mailAccountsKey]);

  const addTask = useCallback((title: string, time: string) => {
    const [hours, minutes] = time.split(":").map(Number);
    const due = new Date();
    due.setHours(hours, minutes, 0, 0);
    setState((current) => ({ ...current, tasks: [...current.tasks, { id: uid(), title, completed: false, dueAt: due.toISOString(), priority: "medium", category: "Личное" }] }));
    setAdding(false);
  }, []);

  const saveEvent = useCallback((event: CalendarEvent) => {
    setState((current) => {
      const exists = current.events.some((item) => item.id === event.id);
      const events = exists ? current.events.map((item) => item.id === event.id ? event : item) : [...current.events, event];
      return { ...current, events: events.sort((left, right) => left.startsAt.localeCompare(right.startsAt)) };
    });
    setEventEditor(null);
  }, []);

  const deleteEvent = useCallback((id: string) => {
    setState((current) => ({ ...current, events: current.events.filter((event) => event.id !== id) }));
    setEventEditor(null);
  }, []);

  const openNewEvent = useCallback(() => setEventEditor("new"), []);
  const openEvent = useCallback((event: CalendarEvent) => setEventEditor(event), []);

  const page = useMemo(() => {
    if (view === "tasks") return <TasksView state={state} setState={setState} onAdd={() => setAdding(true)} />;
    if (view === "calendar") return <CalendarView events={state.events} onAdd={openNewEvent} onEdit={openEvent} />;
    if (view === "mail") return <MailView state={state} setState={setState} searchQuery={searchQuery} />;
    if (view === "widgets") return <WidgetsView />;
    return <TodayView state={state} setState={setState} onAddTask={() => setAdding(true)} onAddEvent={openNewEvent} onEditEvent={openEvent} />;
  }, [openEvent, openNewEvent, searchQuery, state, view]);

  if (isWidget) return <WidgetApp state={state} />;

  return (
    <div className="app-shell">
      <Sidebar view={view} onChange={setView} open={sidebarOpen} onClose={() => setSidebarOpen(false)} unreadCount={state.messages.filter((message) => message.unread).length} />
      {sidebarOpen ? <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Закрыть меню" /> : null}
      <div className="app-content">
        <header className="topbar"><button className="icon-button menu-button" onClick={() => setSidebarOpen(true)}><Menu size={20} /></button><div className="search-box"><Search size={18} /><input ref={searchInput} value={searchQuery} aria-label="Поиск писем" maxLength={200} placeholder="Найти письмо…" onChange={(event) => { setSearchQuery(event.target.value); if (event.target.value.trim()) setView("mail"); }} />{searchQuery ? <button className="search-clear" onClick={() => setSearchQuery("")} aria-label="Очистить поиск"><X size={15} /></button> : <kbd>Ctrl K</kbd>}</div><div className="top-actions"><button className="icon-button notification-button"><Bell size={19} /><i /></button><button className="primary-button quick-add" onClick={() => setAdding(true)}><Plus size={18} />Добавить</button></div></header>
        <main className="content-area">{page}</main>
      </div>
      {adding ? <AddTask onAdd={addTask} onClose={() => setAdding(false)} /> : null}
      {eventEditor ? <EventEditor existing={eventEditor === "new" ? undefined : eventEditor} onSave={saveEvent} onDelete={deleteEvent} onClose={() => setEventEditor(null)} /> : null}
    </div>
  );
}
