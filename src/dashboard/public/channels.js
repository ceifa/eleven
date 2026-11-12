/* What the page knows about channels: each platform's glyph and vocabulary,
   and how a thread's origin and name are drawn from its session key. */

import { h } from "./ui.js";

const TELEGRAM_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Telegram"><circle cx="12" cy="12" r="12" fill="#54A9EB"/><path fill="#fff" d="M17.6 7.2 15.7 16.4c-.14.63-.52.78-1.05.49l-2.9-2.14-1.4 1.35c-.16.16-.29.29-.59.29l.21-2.95 5.37-4.85c.23-.2-.05-.32-.36-.11l-6.64 4.18-2.86-.9c-.62-.2-.63-.62.13-.92l11.18-4.31c.52-.19.97.13.8.87z"/></svg>`;
const DISCORD_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Discord"><circle cx="12" cy="12" r="12" fill="#5865F2"/><path fill="#fff" transform="translate(5.4 5.4) scale(.55)" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>`;
// Local origins get a glyph too — not for decoration: it keeps every name in
// the list starting at the same x, however the thread was born.
const DASHBOARD_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Dashboard" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18"/></svg>`;
const CLI_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="CLI" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7.5 10 2.4 2.3-2.4 2.3M13 14.6h3.6"/></svg>`;
const GOOGLE_CHAT_ICON = `<svg viewBox="0 0 24 24" width="18" height="18" aria-label="Google Chat"><circle cx="12" cy="12" r="12" fill="#00AC47"/><path fill="#fff" d="M7 7.2h10c.6 0 1 .4 1 1v6.4c0 .6-.4 1-1 1h-5.6L8.6 18v-2.4H7c-.6 0-1-.4-1-1V8.2c0-.6.4-1 1-1z"/></svg>`;
const CHANNEL_ICONS = { telegram: TELEGRAM_ICON, discord: DISCORD_ICON, googlechat: GOOGLE_CHAT_ICON, dashboard: DASHBOARD_ICON, cli: CLI_ICON };

/** What each platform calls the parts of the registry, and where its tokens come from. */
const CHANNEL_WORDS = {
  telegram: {
    groups: "Groups",
    groupsInfo: "Group chats the bot lives in — message it inside a group to register it. Each group (and each forum topic) can append its own instructions to the prompt.",
    groupsEmpty: "none yet — message the bot in a group to add it",
    group: "group",
    topics: "Topics",
    topicsInfo: "Each topic gets its own thread and can append its own instructions. Topics register themselves when someone first speaks in them — in a forum group, or in the DM of a bot with topic mode enabled.",
    topic: "topic",
    dmTopics: true,
    tokenHint: "bot token from @BotFather",
    profile: (username) => `https://t.me/${username}`,
  },
  discord: {
    groups: "Servers",
    groupsInfo: "Servers the bot lives in — message it inside a server to register it. Each server (and each of its channels) can append its own instructions to the prompt.",
    groupsEmpty: "none yet — message the bot in a server to add it",
    group: "server",
    topics: "Channels",
    topicsInfo: "Every channel and thread is its own thread here and can append its own instructions. They register themselves when someone first speaks in them, along with the category or channel they sit in — whatever is set on a category reaches every channel in it, and a channel's reaches its threads.",
    topic: "channel",
    dmTopics: false,
    tokenHint: "bot token from the Developer Portal (Message Content intent on)",
    profile: undefined,
  },
  googlechat: {
    groups: "Spaces",
    groupsInfo: "Spaces the app lives in — mention it inside a space to register it. Each space can append its own instructions to the prompt.",
    groupsEmpty: "none yet — mention the app in a space to add it",
    group: "space",
    topics: "Threads",
    topicsInfo: "Every thread in a space is its own thread here.",
    topic: "thread",
    dmTopics: false,
    tokenHint: "path to the app's service account JSON key (googlechat.port and audience go in config.json)",
    profile: undefined,
  },
};
const wordsFor = (type) => CHANNEL_WORDS[type] ?? CHANNEL_WORDS.telegram;

// A thread's origin — the sessionKey's prefix is the channel type
// (telegram:…, dashboard:…). The glyph sits next to the conversation name, so
// a type we have no icon for renders nothing: the name already says "Dashboard"
// or "CLI", and a bare word there would only stutter it.
/** The conversation label without the channel type it opens with — the glyph
 *  next to it already says "telegram", and the word after it only stutters. */
/** What a thread is called on screen: the forum topic, the group, or the person
 *  in the DM — not the first 80 characters they happened to type. The card and
 *  the open thread's head say the same thing, or the one you clicked is not the
 *  one you see. */
const threadName = (thread) => thread.conversationName ?? thread.sessionKey;

function withoutChannelPrefix(label, sessionKey) {
  const type = sessionKey.split(":")[0];
  if (!CHANNEL_ICONS[type]) return label;
  const [first, ...rest] = label.split(" · ");
  // "Telegram DM · Gabriel" loses its first segment; a bare "Dashboard" keeps
  // it, because there it is the whole name.
  return rest.length && first.toLowerCase().replaceAll(" ", "").startsWith(type) ? rest.join(" · ") : label;
}

function channelSource(sessionKey) {
  const type = sessionKey.split(":")[0];
  const icon = CHANNEL_ICONS[type];
  return icon ? h("span", { class: "channel-glyph", title: type, html: icon }) : null;
}

export { CHANNEL_ICONS, wordsFor, threadName, withoutChannelPrefix, channelSource };
