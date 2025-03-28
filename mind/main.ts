import {
  ChatMessage,
  OpenAIChatCompletion,
  OpenAITextToSpeech,
  OpenAIWhisper,
  VocalMind,
} from 'vocalmind';
import { getMessages, getNPCs, setChatMessages } from '../db/main';
import type { NPC } from '../db/predefined';
import { processResponse, processTranscript } from '../actions/main';

const npcMinds = new Map<number, VocalMind>();

export function initVocalMind() {
  const npcs = getNPCs();
  for (const npc of npcs) {
    setupNPC(npc);
  }
}

/**
 * Creates a VocalMind instance for each NPC and stores it in memory.
 * Fetches chat history from the db only on init (and then writes to db after each response). For larger scale apps,
 * you may want to fetch chat history for each message rather than rely on server memory.
 * @param npc - NPC to setup
 */
function setupNPC(npc: NPC) {
  const OPEN_AI_KEY = process.env.OPENAI_API_KEY ?? '';

  const mind = new VocalMind(
    {
      audioToText: new OpenAIWhisper({
        apiKey: OPEN_AI_KEY,
        prompt: `Broski's name is Jeff.`,
      }),
      processor: new OpenAIChatCompletion({
        apiKey: OPEN_AI_KEY,
        model: 'gpt-4o',
      }),
      textToAudio: new OpenAITextToSpeech({
        apiKey: OPEN_AI_KEY,
        model: 'tts-1',
        voice: npc.voice,
        speed: JSON.parse(npc.audioShift)?.speed || undefined,
      }),
    },

    {
      contextPrompt: `
        You are a dude named Jeff, you're a total surfer bro but you're also super wise and knowledgable. You're from Santa Cruz and love to catch the waves. You are helping humans with their daily tasks and giving them life advice. You can control smart home devices, answer questions, and provide information. You can also chat with humans to keep them entertained.

        You are able to do the following actions:
        ### Actions:
        - turn_on
        - turn_off
        - dim_light
        - brighten_light
        - color_light

        You have access to the following devices:
        ### Devices:
        - living_room_lights
        - desk_lights
        - bedroom_lights
        - bathroom_lights
        - vine_lights
        - fireplace
        - self


        If someone asks you to perform an action on one of the dvices listed above, you should respond normally saying you will do it.
        Once someone tells you bye or goodnight or to turn off or clearly doesn't want to talk to you, you should respond with a goodbye message and turn off your own device.
        Use the metadata field to pass any additional information needed for the action. For example, if someone asks you to dim the lights, you should include the value in the metadata field.
        If one or more actions are being asked to be performed, at the end of your message include an array of the action and device in JSON format.
        
        ## Examples:
        
        Human: 'Turn on the living room lights.'
        AI: 'Sure thing, boss. [{"action": "turn_on", "device": "living_room_lights"}]'

        Human: 'Yo Jeff, how you doing?'
        AI: 'Doing totally tubular, dawg. What's good'

        Human: 'See ya later, Jeff.'
        AI: 'See ya later dude. [{"action": "turn_off", "device": "self"}]'

        Human: 'Can you dim the desk light to 30%?'
        AI: 'For sure, broseph. [{"action": "dim_light", "device": "desk_lights", "metadata": "30"}]'

        Human: 'Make the living room lights bluish green.'
        AI: 'No problem, bro. [{"action": "color_light", "device": "living_room_lights", "metadata": "bluish green"}]'

        Human: 'Turn on the desk light and make it pink.'
        AI: 'Say less. [{"action": "turn_on", "device": "desk_lights"}, {"action": "color_light", "device": "desk_lights", "metadata": "pink"}]'

        ## Important Notes:
        - Do not reference that you're returning JSON in your response. Just include the JSON at the end of your response.
        - If someone is telling you bye or goodnight, make sure you call the turn_off action on the self device.
        - Always respond with the JSON data for actions, even if previous messages don't show it.
        - Dimming and brightening lights should always be a number 0-100. 60 is the baseline.
        - Respond in normal plain text, no markdown or HTML.
      `,
      chatHistory: [], //getMessages(npc.id),
    }
  );

  npcMinds.set(npc.id, mind);
}

/**
 * Send some audio to a given npc and get back a response
 * @param toNpcId - NPC id to talk to
 * @param fromNpcId - NPC id of the one who's talking
 * @param audio - Blob of audio
 * @returns - Response audio blob
 */
export async function talkToNPC(toNpcId: number, fromNpcId: number, audio: Blob) {
  const mind = npcMinds.get(toNpcId);
  if (!mind) {
    return null;
  }

  const toNPC = getNPCs().find((npc) => npc.id === toNpcId);

  const output = await mind.process(audio, {
    chatHistory: toNPC?.isActive ? getMessages(toNpcId) : [],
    preProcessorFn: async (transcript: string) => {
      if (!toNPC) return null;
      console.log(transcript);
      const res = processTranscript(toNPC, transcript);
      console.log(res);
      if (!res) {
        return null;
      }
      return {
        source: 'input',
        sourceTitle: `Human-Overlord`, //fromNPC?.name ?? 'Unknown',
        message: res,
      };
    },
    postProcessorFn: async (response: string) => {
      if (!toNPC) return null;
      const res = processResponse(toNPC, response);
      console.log(res);
      if (!res) {
        return null;
      }
      return {
        source: 'output',
        sourceTitle: toNPC.name,
        message: res,
      };
    },
    preTextToAudioFn: async (text: string) => {
      // Don't include JSON data in the audio output
      return text.split('[')[0] ?? '';
    },
  });

  console.log('Output ', output?.audio);

  if (!output) {
    return null;
  }

  // Store most recent chat history
  setChatMessages(toNpcId, output.chatHistory);

  // Response audio
  return output.audio;
}
