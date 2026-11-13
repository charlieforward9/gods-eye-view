import {
  MAP_CHAT_INSTRUCTIONS,
  MAP_CHAT_TOOL_PROFILE,
  MAP_CHAT_TOOLS,
} from '../../../src/voice/mapChatTools.js';
import { offeredTools } from '../openai/tools.js';

/** Clients select a server-owned profile, never supply schemas or instructions. */
export function validTextToolProfile(profile) {
  return profile === undefined || profile === MAP_CHAT_TOOL_PROFILE;
}

export function textProfileTools(tools, { overpass, profile } = {}) {
  const base = offeredTools(tools, { overpass });
  if (profile !== MAP_CHAT_TOOL_PROFILE) return base;
  return [
    ...new Map(
      [...base, ...MAP_CHAT_TOOLS].map((tool) => [tool.name, tool]),
    ).values(),
  ];
}

export function textProfileInstructions(instructions, profile) {
  return profile === MAP_CHAT_TOOL_PROFILE
    ? `${instructions}\n${MAP_CHAT_INSTRUCTIONS}`
    : instructions;
}
