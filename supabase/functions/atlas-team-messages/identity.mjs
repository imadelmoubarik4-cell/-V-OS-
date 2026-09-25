// Sender identity for Messages (S92, S87 rule).
//
// A message shows its sender by sender_id → the live profile display name
// (actorLabel), else the name stored when it was sent, else a neutral label:
// "Team member" for an active profile without a name, "Former team member"
// for someone no longer on the active roster. The stored labels are audit
// history and are never rewritten in the database, but an email-shaped stored
// label never leaves the gateway (S87: an address is never a label, not in
// responses either). Plain ESM, unit-tested in Node.
import { SAFE_ACTOR_LABEL, actorLabel, safeDisplayName } from "../_shared/auth.mjs";

export const FORMER_MEMBER_LABEL = "Former team member";
export const SYSTEM_SENDER_LABEL = "Atlas";

const NEUTRAL_LABELS = new Set([SAFE_ACTOR_LABEL.toLowerCase(), FORMER_MEMBER_LABEL.toLowerCase()]);

// A person's real name, or null for blank, email-shaped or neutral labels.
export function realName(value) {
  const name = safeDisplayName(value);
  return name && !NEUTRAL_LABELS.has(name.toLowerCase()) ? name : null;
}

// id → label for the active roster (profiles rows from /rest/v1/profiles).
export function rosterLabels(profiles) {
  const labels = new Map();
  for (const profile of Array.isArray(profiles) ? profiles : []) {
    if (profile && typeof profile.id === "string") labels.set(profile.id, actorLabel(profile));
  }
  return labels;
}

// The name shown for a message (or a channel's last_message).
export function senderName(message, labels) {
  if (!message) return SAFE_ACTOR_LABEL;
  if (message.message_type === "system") return SYSTEM_SENDER_LABEL;
  const id = typeof message.sender_id === "string" ? message.sender_id : null;
  const live = id ? labels.get(id) : undefined;
  const name = realName(live) ?? realName(message.sender_label);
  if (name) return name;
  // Without sender_id (an older snapshot shape) nothing says the person left.
  if (live !== undefined || message.sender_id === undefined) return SAFE_ACTOR_LABEL;
  return FORMER_MEMBER_LABEL;
}

function withName(message, labels) {
  if (!message || typeof message !== "object") return message;
  const readBy = Array.isArray(message.read_by)
    ? message.read_by.map((reader) => (reader && typeof reader === "object"
      ? {
        ...reader,
        user_label: safeDisplayName(reader.user_label),
        user_name: realName(labels.get(reader.user_id)) ?? realName(reader.user_label) ?? SAFE_ACTOR_LABEL,
      }
      : reader))
    : message.read_by;
  const id = typeof message.sender_id === "string" ? message.sender_id : null;
  return {
    ...message,
    sender_label: safeDisplayName(message.sender_label),
    sender_name: senderName(message, labels),
    sender_active: message.message_type === "system" ? true : Boolean(id && labels.has(id)),
    ...(readBy === undefined ? {} : { read_by: readBy }),
  };
}

// Adds sender_name / sender_active to every message and conversation preview,
// user_name to read receipts, and drops email-shaped stored labels.
export function withSenderNames(snapshot, profiles) {
  if (!snapshot || typeof snapshot !== "object") return snapshot;
  const labels = rosterLabels(profiles);
  return {
    ...snapshot,
    messages: Array.isArray(snapshot.messages) ? snapshot.messages.map((message) => withName(message, labels)) : snapshot.messages,
    channels: Array.isArray(snapshot.channels)
      ? snapshot.channels.map((channel) => (channel && channel.last_message
        ? { ...channel, last_message: withName(channel.last_message, labels) }
        : channel))
      : snapshot.channels,
  };
}
