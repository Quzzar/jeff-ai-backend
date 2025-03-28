import { makeActiveNPC, setChatMessages } from '../db/main';
import type { NPC } from '../db/predefined';

const OPEN_AI_KEY = process.env.OPENAI_API_KEY ?? '';
const HUE_BRIDGE_IP = process.env.HUE_BRIDGE_IP ?? '';
const HUE_APP_KEY = process.env.HUE_APP_KEY ?? '';

export function processTranscript(npc: NPC, transcript: string): string | null {
  if (
    (transcript.includes(`Hey ${npc.name}`) ||
      transcript.includes(`Hey, ${npc.name}`) ||
      transcript.includes(`Sup ${npc.name}`) ||
      transcript.includes(`Sup, ${npc.name}`) ||
      transcript.includes(`Yo ${npc.name}`) ||
      transcript.includes(`Yo, ${npc.name}`) ||
      transcript.includes(`What's up  ${npc.name}`) ||
      transcript.includes(`What's up, ${npc.name}`)) &&
    !npc.isActive
  ) {
    makeActiveNPC(npc.id, true);
    npc.isActive = true;
    setChatMessages(npc.id, []);
  }

  if (!npc.isActive) {
    return null;
  }

  if (
    transcript.toLowerCase().includes('restart yourself') ||
    transcript.toLowerCase().includes('reset yourself')
  ) {
    turnOff(npc);
    // Continue processing the transcript though
  }

  return transcript;
}

type Action = { action: string; device: string; metadata?: string };

export function processResponse(npc: NPC, response: string): string | null {
  const parts = response.split('[');
  const responseStr = parts[0]?.trim() ?? '';
  const actionStr = parts[1]?.trim() ?? '';

  // Might not need this anymore //
  // if (
  //   !actionStr &&
  //   (responseStr.toLowerCase().includes('later, dude') ||
  //     responseStr.toLowerCase().includes('later dude'))
  // ) {
  //   turnOff(npc);
  //   return response;
  // }

  let actions: Action[] | null = null;
  if (actionStr) {
    try {
      actions = JSON.parse(
        `[${actionStr}`
          .replace(/^[`"'*]+|[`"'*]+$/g, '')
          .replace(/'/g, '"')
          .replace(/`/g, '"')
          .replace(/\\/g, '')
      ) as Action[];
    } catch (e) {
      console.error(e);
      return response;
    }
  }
  if (!actions) {
    return response;
  }

  (async () => {
    // Make sure it's an array of actions
    actions = !Array.isArray(actions) ? [actions] : actions;

    // Execute in order
    for (let action of actions) {
      await handleActionCommand(npc, {
        action: action.action?.trim().toLowerCase(),
        device: action.device?.trim().toLowerCase(),
        metadata: action.metadata?.trim().toLowerCase(),
      });
    }
  })();

  return response;
}

// Action Commands //

async function handleActionCommand(npc: NPC, action: Action) {
  console.log('Action:', action);

  if (action.action === 'turn_off' && action.device === 'self') {
    turnOff(npc);
    return;
  }

  if (action.action === 'turn_on' || action.action === 'turn_off') {
    const lightIds = getLightIds(action.device);
    for (const lightId of lightIds) {
      activateLight(action.action === 'turn_on', lightId);
    }
  }

  if (
    (action.action === 'dim_light' || action.action === 'brighten_light') &&
    action.metadata &&
    typeof action.metadata === 'string'
  ) {
    const lightIds = getLightIds(action.device);
    for (const lightId of lightIds) {
      adjustLight(action.metadata, lightId);
    }
  }

  if (action.action === 'color_light' && action.metadata && typeof action.metadata === 'string') {
    const lightIds = getLightIds(action.device);
    const gamut = await convertColorToGamut(action.metadata);
    for (const lightId of lightIds) {
      colorLight(gamut, lightId);
    }
  }
}

function getLightIds(device: string): string[] {
  if (device.includes('living_room') || device.includes('bedroom') || device.includes('room')) {
    // TEMP: While I only have 1 room, any room is this room
    return [process.env.HUE_LIVING_ROOM_LIGHT_1_ID!, process.env.HUE_LIVING_ROOM_LIGHT_2_ID!];
  }
  if (device.includes('desk')) {
    return [process.env.HUE_DESK_LIGHT_ID!];
  }
  if (device.includes('fire')) {
    return [process.env.HUE_FIREPLACE_LIGHT_ID!];
  }
  if (device.includes('vine')) {
    return [process.env.HUE_BEDROOM_LIGHT_ID!];
  }
  if (device.includes('bathroom')) {
    return [process.env.HUE_BATHROOM_LIGHT_ID!];
  }

  return [];
}

async function colorLight(
  gamut: {
    x: number;
    y: number;
  },
  lightId: string
) {
  return fetchHue(`resource/light/${lightId}`, 'PUT', {
    color: {
      xy: gamut,
    },
  });
}

async function adjustLight(dimness: string, lightId: string) {
  return fetchHue(`resource/light/${lightId}`, 'PUT', {
    dimming: {
      brightness: parseInt(dimness),
    },
  });
}

async function activateLight(enabled: boolean, lightId: string) {
  return fetchHue(`resource/light/${lightId}`, 'PUT', {
    on: {
      on: enabled,
    },
  });
}

async function fetchHue(endpoint: string, method: string, body: Record<string, any>) {
  const res = await fetch(`https://${HUE_BRIDGE_IP}/clip/v2/${endpoint}`, {
    method: method,
    headers: {
      'Content-Type': 'application/json',
      'hue-application-key': HUE_APP_KEY,
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function convertColorToGamut(color: string) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPEN_AI_KEY}`,
    },
    body: JSON.stringify({
      model: 'gpt-4',
      messages: [
        {
          role: 'user',
          content: `
I'm going to give you a description of a color and you need to respond only with roughly that color in gamut C coords in JSON format.

## Examples:
Input: bluish green
Output: {"x": "0.245", "y": "0.401"}

Input: red
Output: {"x": "0.640", "y": "0.330"}

Input: warm room light
Output: {"x": "0.4994", "y": "0.4153"}


Input: ${color}
      `.trim(),
        },
      ],
    }),
  });
  const response = (await res.json()) as Record<string, any>;

  if (!response.error) {
    const res = response.choices[0].message.content;
    try {
      const color = JSON.parse(res.split('put: ')[1].trim());
      if (Array.isArray(color)) {
        // Average the colors
        const x = color.reduce((acc, c) => acc + c.x, 0) / color.length;
        const y = color.reduce((acc, c) => acc + c.y, 0) / color.length;
        return { x, y };
      } else {
        return { x: parseFloat(color.x), y: parseFloat(color.y) };
      }
    } catch (e) {}
  }
  return { x: 0.4994, y: 0.4153 };
}

function turnOff(npc: NPC) {
  makeActiveNPC(npc.id, false);
  npc.isActive = false;
}
