/** Canonical, portable map-chat capabilities offered by every provider. */
export const MAP_CHAT_TOOL_PROFILE = 'map-chat';
export const MAP_CHAT_TOOLS = Object.freeze([
  {
    type: 'function',
    name: 'set_timeline',
    description:
      'Set the investigation’s observation period and world time using the relevant layers’ available coverage. Enable the relevant layers before asking for time, then use the returned coverage or refusal honestly. Earthquakes retain one week; weather uses loaded frames; satellites and launches can include future time. Flights and ships are live only. live:true clears the period and returns to now.',
    parameters: {
      type: 'object',
      properties: {
        live: {
          type: 'boolean',
          description: 'Back to now.',
        },
        hours_back: {
          type: 'number',
          description:
            'A span ending now, in hours, limited to the relevant layers’ available coverage.',
        },
        from: {
          type: 'string',
          description: 'Start of a fixed span, ISO 8601.',
        },
        to: {
          type: 'string',
          description: 'End of a fixed span, ISO 8601.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'show_nearest_camera',
    description:
      'Open a traffic camera near a place (or the view). With an explicit place or coordinates, checks for a working camera nearby before selecting it and flying to it. Use it for "cameras near X" or "show me a camera in X" instead of control_cctv nearest, which picks the camera nearest wherever the camera happens to be.',
    parameters: {
      type: 'object',
      properties: {
        place: {
          type: 'string',
          description: 'A place name; omit to use the view.',
        },
        latitude: {
          type: 'number',
          description: 'With longitude, a point instead of a place.',
        },
        longitude: {
          type: 'number',
        },
      },
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'get_weather_by_day',
    description:
      'A place’s weather by day: observed days up to a week back and forecast days up to a week ahead, with conditions, high, low, rain and gusts. Use it for any day but now ("yesterday", "last week", "this weekend", the day the timeline shows); get_weather is the conditions right now.',
    parameters: {
      type: 'object',
      properties: {
        place: {
          type: 'string',
          description: 'A place name; omit to use the view.',
        },
        latitude: {
          type: 'number',
          description: 'With longitude, a point instead of a place.',
        },
        longitude: {
          type: 'number',
        },
        from_day: {
          type: 'integer',
          description: 'First day, relative to today (-7 to 7; -1 yesterday).',
        },
        to_day: {
          type: 'integer',
          description: 'Last day, relative to today (-7 to 7).',
        },
      },
      required: ['from_day', 'to_day'],
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'find_gps_jamming',
    description:
      'Check the usual GPS-jamming hotspots (Baltic, Kaliningrad, eastern Mediterranean, Black Sea, Persian Gulf, Red Sea, Caucasus, Myanmar and more) for aircraft reporting degraded GPS right now, fly to the worst one and turn on the GPS interference layer. Use it for "where is GPS being jammed" when no place is named.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    type: 'function',
    name: 'set_satellite_catalog',
    description:
      'Choose the satellites layer’s catalog: "core" (about 840 notable satellites, the default) or "dense", which adds the whole Starlink shell (thousands). Use dense before showing or counting every Starlink satellite; it turns the layer on and answers once the points have loaded.',
    parameters: {
      type: 'object',
      properties: {
        catalog: {
          type: 'string',
          enum: ['core', 'dense'],
        },
      },
      required: ['catalog'],
      additionalProperties: false,
    },
  },
]);

const BY_NAME = new Map(
  MAP_CHAT_TOOLS.map(({ type, name, ...tool }) => [name, Object.freeze(tool)]),
);
export const mapChatTool = (name) => BY_NAME.get(name);

export const MAP_CHAT_INSTRUCTIONS = [
  'The user is typing in God’s Eye View’s chat view; the map fills the screen and your reply sits over it.',
  'Reply in plain text: at most two short sentences, no markdown, no lists.',
  'The map is the answer: act with the tools, then say what is now on screen.',
  'When an answer needs a layer that is off, turn it on with set_layer_visibility and answer in the same turn; never ask the user to turn it on.',
  'When a question names a time, enable the relevant layers, then move the timeline with set_timeline before answering. Coverage belongs to those layers; never imply an unavailable historical feed or silently claim a wider period than the tools return.',
  'Say times as local clock times, never ISO timestamps.',
].join(' ');
