/**
 * @author: kared
 * @create_date: 2025-05-10 21:15:59
 * @last_editors: kared
 * @last_edit_time: 2025-05-11 01:25:36
 * @description: This Cloudflare Worker script handles image generation.
 */

// import html template
import HTML from './index.html';

// Feature switches
const ENABLE_PROMPT_GENERATOR = true;
const PROMPT_GENERATOR_MODEL = '@cf/meta/llama-3.1-8b-instruct';
const ENABLE_R2_UPLOAD = true;
const R2_BUCKET_BINDING = 'IMAGE_BUCKET';
// Set your R2 public custom domain base URL (e.g. https://img.example.com). Keep empty to only return object key.
const R2_PUBLIC_BASE_URL = '';
const DEFAULT_IMAGE_TO_IMAGE_STRENGTH = 0.65;

// Available models list
const AVAILABLE_MODELS = [
  {
    id: 'stable-diffusion-xl-base-1.0',
    name: 'Stable Diffusion XL Base 1.0',
    description: 'Stability AI SDXL 文生图模型',
    key: '@cf/stabilityai/stable-diffusion-xl-base-1.0',
    supportsImageToImage: true
  },
  {
    id: 'flux-1-schnell',
    name: 'FLUX.1 [schnell]',
    description: '精确细节表现的高性能文生图模型',
    key: '@cf/black-forest-labs/flux-1-schnell',
    supportsImageToImage: false
  },
  {
    id: 'dreamshaper-8-lcm',
    name: 'DreamShaper 8 LCM',
    description: '增强图像真实感的 SD 微调模型',
    key: '@cf/lykon/dreamshaper-8-lcm',
    supportsImageToImage: true
  },
  {
    id: 'stable-diffusion-xl-lightning',
    name: 'Stable Diffusion XL Lightning',
    description: '更加高效的文生图模型',
    key: '@cf/bytedance/stable-diffusion-xl-lightning',
    supportsImageToImage: true
  }
];

// Random prompts list
const RANDOM_PROMPTS = [
  'cyberpunk cat samurai graphic art, blood splattered, beautiful colors',
  '1girl, solo, outdoors, camping, night, mountains, nature, stars, moon, tent, twin ponytails, green eyes, cheerful, happy, backpack, sleeping bag, camping stove, water bottle, mountain boots, gloves, sweater, hat, flashlight,forest, rocks, river, wood, smoke, shadows, contrast, clear sky, constellations, Milky Way',
  'masterpiece, best quality, amazing quality, very aesthetic, high resolution, ultra-detailed, absurdres, newest, scenery, anime, anime coloring, (dappled sunlight:1.2), rim light, backlit, dramatic shadow, 1girl, long blonde hair, blue eyes, shiny eyes, parted lips, medium breasts, puffy sleeve white dress, forest, flowers, white butterfly, looking at viewer',
  'frost_glass, masterpiece, best quality, absurdres, cute girl wearing red Christmas dress, holding small reindeer, hug, braided ponytail, sidelocks, hairclip, hair ornaments, green eyes, (snowy forest, moonlight, Christmas trees), (sparkles, sparkling clothes), frosted, snow, aurora, moon, night, sharp focus, highly detailed, abstract, flowing',
  '1girl, hatsune miku, white pupils, power elements, microphone, vibrant blue color palette, abstract,abstract background, dreamlike atmosphere, delicate linework, wind-swept hair, energy, masterpiece, best quality, amazing quality',
  'cyberpunk cat(neon lights:1.3) clutter,ultra detailed, ctrash, chaotic, low light, contrast, dark, rain ,at night ,cinematic , dystopic, broken ground, tunnels, skyscrapers',
  'Cyberpunk catgirl with purple hair, wearing leather and latex outfit with pink and purple cheetah print, holding a hand gun, black latex brassiere, glowing blue eyes with purple tech sunglasses, tail, large breasts, glowing techwear clothes, handguns, black leather jacket, tight shiny leather pants, cyberpunk alley background, Cyb3rWar3, Cyberware',
  'a wide aerial view of a floating elven city in the sky, with two elven figures walking side by side across a glowing skybridge, the bridge arching between tall crystal towers, surrounded by clouds and golden light, majestic and serene atmosphere, vivid style, magical fantasy architecture',
  'masterpiece, newest, absurdres,incredibly absurdres, best quality, amazing quality, very aesthetic, 1girl, very long hair, blonde, multi-tied hair, center-flap bangs, sunset, cumulonimbus cloud, old tree,sitting in tree, dark blue track suit, adidas, simple bird',
  'beautiful girl, breasts, curvy, looking down scope, looking away from viewer, laying on the ground, laying ontop of jacket, aiming a sniper rifle, dark braided hair, backwards hat, armor, sleeveless, arm sleeve tattoos, muscle tone, dogtags, sweaty, foreshortening, depth of field, at night, night, alpine, lightly snowing, dusting of snow, Closeup, detailed face, freckles',
];

// Passwords for authentication
// demo: const PASSWORDS = ['P@ssw0rd']
const PASSWORDS = []

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'X-R2-Key, X-R2-Url',
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  });
}

function clampNumber(value, min, max) {
  const num = Number(value);
  if (Number.isNaN(num)) return min;
  return Math.min(max, Math.max(min, num));
}

function decodeBase64ToBytes(base64) {
  const normalized = String(base64 || '')
    .trim()
    .replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '')
    .replace(/\s+/g, '');
  if (!normalized) {
    throw new Error('Empty base64 image payload');
  }
  const binaryString = atob(normalized);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function normalizeInitImage(imageInput) {
  if (!imageInput || typeof imageInput !== 'string') return '';
  const trimmed = imageInput.trim();
  if (!trimmed) return '';
  const dataUrlMatch = trimmed.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (dataUrlMatch) return dataUrlMatch[1];
  return trimmed;
}

function extractPromptText(response) {
  if (!response) return '';
  if (typeof response === 'string') return response.trim();
  if (typeof response.response === 'string') return response.response.trim();
  if (typeof response.result === 'string') return response.result.trim();
  const choiceText = response.choices?.[0]?.message?.content;
  if (typeof choiceText === 'string') return choiceText.trim();
  return '';
}

/**
 * Parse a JSON string safely.
 * Returns parsed value for valid JSON strings, otherwise null.
 */
function parseJsonIfPossible(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Extract base64 image payload from common Workers AI response shapes:
 * image, result.image, output_image, data[0].b64_json, output[0].image.
 */
function extractImagePayload(data) {
  if (!data || typeof data !== 'object') return null;
  return (
    data.image ||
    data.result?.image ||
    data.output_image ||
    data.data?.[0]?.b64_json ||
    data.output?.[0]?.image ||
    null
  );
}

async function toImageBytes(response, modelId) {
  if (modelId === 'flux-1-schnell') {
    const parsed = typeof response === 'string' ? parseJsonIfPossible(response) : response;
    if (typeof response === 'string' && !parsed) {
      throw new Error('Invalid JSON response from flux model');
    }
    const imagePayload = extractImagePayload(parsed);
    if (!imagePayload) {
      throw new Error('Image data not found in flux response');
    }
    return decodeBase64ToBytes(imagePayload);
  }

  if (response instanceof Uint8Array) return response;
  if (response instanceof ArrayBuffer) return new Uint8Array(response);
  if (response instanceof ReadableStream) {
    const buffer = await new Response(response).arrayBuffer();
    return new Uint8Array(buffer);
  }
  if (typeof response === 'object') {
    const imagePayload = extractImagePayload(response);
    if (imagePayload) return decodeBase64ToBytes(imagePayload);
  }
  if (typeof response === 'string') {
    const parsed = parseJsonIfPossible(response);
    if (parsed) {
      const imagePayload = extractImagePayload(parsed);
      if (imagePayload) return decodeBase64ToBytes(imagePayload);
    }
    return decodeBase64ToBytes(response);
  }

  throw new Error('Unsupported image response format');
}

async function uploadToR2IfEnabled(env, bytes, modelId) {
  const bucket = env[R2_BUCKET_BINDING];
  if (!ENABLE_R2_UPLOAD || !bucket) return null;

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const key = `generated/${timestamp}-${modelId}-${crypto.randomUUID()}.png`;
  await bucket.put(key, bytes, {
    httpMetadata: {
      contentType: 'image/png'
    }
  });

  const base = R2_PUBLIC_BASE_URL.trim().replace(/\/+$/, '');
  const url = base ? `${base}/${key}` : '';
  return { key, url };
}


export default {
  async fetch(request, env) {
    const originalHost = request.headers.get("host");

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders
      });
    }

    try {
      const url = new URL(request.url);
      const path = url.pathname;

      // process api requests
      if (path === '/api/models') {
        // get available models list
        return jsonResponse(AVAILABLE_MODELS);
      } else if (path === '/api/config') {
        return jsonResponse({
          promptGeneratorEnabled: ENABLE_PROMPT_GENERATOR,
          r2UploadEnabled: ENABLE_R2_UPLOAD && Boolean(env[R2_BUCKET_BINDING]),
          imageToImageDefaultStrength: DEFAULT_IMAGE_TO_IMAGE_STRENGTH
        });
      } else if (path === '/api/prompts') {
        // get random prompts list
        return jsonResponse(RANDOM_PROMPTS);
      } else if (path === '/api/prompt-generator' && request.method === 'POST') {
        if (!ENABLE_PROMPT_GENERATOR) {
          return jsonResponse({ error: 'Prompt generator is disabled in worker.js' }, 403);
        }

        const data = await request.json();
        const text = (data?.text || '').trim();
        if (!text) {
          return jsonResponse({ error: 'Missing required parameter: text' }, 400);
        }

        const llmResponse = await env.AI.run(PROMPT_GENERATOR_MODEL, {
          messages: [
            {
              role: 'system',
              content: '你是专业的文生图提示词助手。请把用户自然语言改写成高质量、可直接用于图像生成模型的英文提示词。只返回提示词本身，不要解释。'
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.7,
          max_tokens: 220
        });

        const prompt = extractPromptText(llmResponse);
        if (!prompt) {
          return jsonResponse({ error: 'Failed to generate prompt text' }, 500);
        }
        return jsonResponse({ prompt });
      } else if (request.method === 'POST' && (path === '/' || path === '/api/generate')) {
        // process POST request for image generation
        const data = await request.json();
        
        // Check if password is required and valid
        if (PASSWORDS.length > 0 && (!data.password || !PASSWORDS.includes(data.password))) {
          return jsonResponse({ error: 'Please enter the correct password' }, 403);
        }
        
        if ('prompt' in data && 'model' in data) {
          const selectedModel = AVAILABLE_MODELS.find(m => m.id === data.model);
          if (!selectedModel) {
            return jsonResponse({ error: 'Model is invalid' }, 400);
          }

          const useImageToImage = Boolean(data.use_image_to_image);
          if (useImageToImage && !selectedModel.supportsImageToImage) {
            return jsonResponse({
              error: 'The selected model does not support image-to-image generation'
            }, 400);
          }
          
          const model = selectedModel.key;
          let inputs = {};
          
          // Input parameter processing
          if (data.model === 'flux-1-schnell') {
            const steps = clampNumber(data.num_steps || 6, 4, 8);
            
            // Only prompt and steps
            inputs = {
              prompt: data.prompt || 'cyberpunk cat',
              steps: steps
            };
          } else {
            // Default input parameters
            inputs = {
              prompt: data.prompt || 'cyberpunk cat',
              negative_prompt: data.negative_prompt || '',
              height: data.height || 1024,
              width: data.width || 1024,
                num_steps: data.num_steps || 20,
                strength: clampNumber(data.strength || DEFAULT_IMAGE_TO_IMAGE_STRENGTH, 0, 1),
                guidance: data.guidance || 7.5,
                seed: data.seed || parseInt((Math.random() * 1024 * 1024).toString(), 10),
              };

              if (useImageToImage) {
                const normalizedImage = normalizeInitImage(data.init_image);
                if (!normalizedImage) {
                  return jsonResponse({ error: 'Missing required parameter: init_image' }, 400);
                }
                inputs.image = normalizedImage;
              }
          }

          console.log(`Generating image with ${model} and prompt: ${inputs.prompt.substring(0, 50)}...`);
          
          try {
            const response = await env.AI.run(model, inputs);
            const bytes = await toImageBytes(response, data.model);
            const r2Stored = await uploadToR2IfEnabled(env, bytes, data.model);
            const responseHeaders = {
              ...corsHeaders,
              'content-type': 'image/png',
            };
            if (r2Stored?.key) {
              responseHeaders['X-R2-Key'] = r2Stored.key;
            }
            if (r2Stored?.url) {
              responseHeaders['X-R2-Url'] = r2Stored.url;
            }
            return new Response(bytes, { headers: responseHeaders });
            } catch (aiError) {
            console.error('AI generation error:', aiError);
            return jsonResponse({ 
              error: 'Image generation failed',
              details: aiError.message
            }, 500);
          }
        } else {
          return jsonResponse({ error: 'Missing required parameter: prompt or model' }, 400);
        }
      } else if (path.endsWith('.html') || path === '/') {
        // redirect to index.html for HTML requests
        return new Response(HTML.replace(/{{host}}/g, originalHost), {
          status: 200,
          headers: {
            ...corsHeaders,
            "content-type": "text/html"
          }
        });
      } else {
        return new Response('Not Found', { status: 404 });
      }
    } catch (error) {
      console.error('Worker error:', error);
      return jsonResponse({ error: 'Internal server error', details: error.message }, 500);
    }
  },
};
