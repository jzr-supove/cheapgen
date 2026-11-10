// The canonical request. Fills in the tool's own defaults before any provider
// sees the request, so every provider receives explicit values, and checks the
// request against the model's options so a bad option fails before any network call.
import fs from 'node:fs';
import path from 'node:path';
import { usageError } from './errors.js';

/**
 * @typedef {object} CanonicalRequest
 * @property {string} model
 * @property {'video'|'image'} kind
 * @property {string} [frameSeries]
 * @property {'text-to-video'|'image-to-video'|'text-to-image'} mode
 * @property {string} [prompt]
 * @property {string} [image]          URL, or absolute local path when imageIsLocal
 * @property {boolean} [imageIsLocal]
 * @property {string} [resolution]     video
 * @property {string} [size]           image
 * @property {string} aspectRatio
 * @property {number} [duration]       seconds; -1 when autoDuration
 * @property {boolean} [autoDuration]  the provider picks the length; priced at the maximum
 * @property {number} [maxDuration]
 * @property {boolean} [audio]
 * @property {number} count
 */

export const DEFAULTS = Object.freeze({ resolution: '720p', duration: 5, aspectRatio: '16:9', audio: true, size: '1K' });

const isUrl = (s) => /^https?:\/\//i.test(s);

/**
 * @param {string} modelId
 * @param {object} flags   parsed command-line values
 * @param {object} catalog
 * @param {{ cwd: string, requirePrompt: boolean }} opts
 * @returns {CanonicalRequest}
 */
export function buildCanonicalRequest(modelId, flags, catalog, { cwd, requirePrompt }) {
  if (!modelId) throw usageError('name a model, for example: cheapgen quote seedance-2.0-mini');
  const model = catalog.models[modelId];
  if (!model) {
    throw usageError(`unknown model "${modelId}". Run \`cheapgen models\` to see the supported models.`);
  }

  const prompt = flags.prompt;
  if (requirePrompt && (typeof prompt !== 'string' || !prompt.trim())) {
    throw usageError('--prompt is required');
  }

  let image;
  let imageIsLocal = false;
  if (flags.image !== undefined) {
    if (isUrl(flags.image)) image = flags.image;
    else {
      image = path.resolve(cwd, flags.image);
      if (!fs.existsSync(image)) throw usageError(`--image file not found: ${flags.image}`);
      imageIsLocal = true;
    }
  }

  const aspectRatio = flags.aspect ?? DEFAULTS.aspectRatio;
  if (!model.aspectRatios.includes(aspectRatio)) {
    throw usageError(`${modelId} doesn't support aspect ratio ${aspectRatio}. Choose one of: ${model.aspectRatios.join(', ')}`);
  }

  if (model.kind === 'image') {
    if (image) throw usageError(`${modelId} is a text-to-image model; --image isn't supported yet`);
    for (const f of ['res', 'duration', 'audio', 'no-audio']) {
      if (flags[f] !== undefined) throw usageError(`--${f} doesn't apply to image models`);
    }
    const size = flags.size ?? (model.sizes?.includes(DEFAULTS.size) ? DEFAULTS.size : model.sizes?.[0]);
    if (model.sizes && !model.sizes.includes(size)) {
      throw usageError(`${modelId} doesn't support size ${size}. Choose one of: ${model.sizes.join(', ')}`);
    }
    return withMode(model, { model: modelId, kind: 'image', frameSeries: model.frameSeries ?? modelId,
      mode: 'text-to-image', prompt, size, aspectRatio, count: 1 });
  }

  if (flags.size !== undefined) throw usageError('--size applies to image models; use --res for video');
  const resolution = flags.res ?? DEFAULTS.resolution;
  if (!model.resolutions.includes(resolution)) {
    throw usageError(`${modelId} doesn't support ${resolution}. Choose one of: ${model.resolutions.join(', ')}`);
  }

  let duration = DEFAULTS.duration;
  let autoDuration = false;
  if (flags.duration !== undefined) {
    const raw = String(flags.duration).trim().toLowerCase();
    if (raw === 'auto' || raw === '-1') {
      if (!flags['allow-auto-duration']) {
        throw usageError('--duration auto lets the provider choose the length, so the cost is only known afterwards. '
          + 'Pass a number of seconds, or add --allow-auto-duration to accept the maximum possible cost.');
      }
      autoDuration = true;
      duration = -1;
    } else {
      duration = Number(raw);
      if (!Number.isInteger(duration)) throw usageError(`--duration must be a whole number of seconds, got "${flags.duration}"`);
    }
  }
  const { min, max } = model.durations;
  if (!autoDuration && (duration < min || duration > max)) {
    throw usageError(`${modelId} supports durations from ${min} to ${max} seconds, got ${duration}`);
  }

  if (flags.audio && flags['no-audio']) throw usageError('pass either --audio or --no-audio, not both');
  const audio = flags['no-audio'] ? false : DEFAULTS.audio;

  return withMode(model, {
    model: modelId, kind: 'video', frameSeries: model.frameSeries ?? modelId,
    mode: image ? 'image-to-video' : 'text-to-video',
    prompt, image, imageIsLocal, resolution, aspectRatio, duration, autoDuration, maxDuration: max, audio, count: 1,
  });
}

function withMode(model, request) {
  if (!model.modes.includes(request.mode)) {
    throw usageError(`${request.model} doesn't support ${request.mode}. It supports: ${model.modes.join(', ')}`);
  }
  return Object.freeze(request);
}

/** The request as priced: an auto duration is priced at the model's maximum. */
export const pricedRequest = (request) =>
  (request.autoDuration ? { ...request, duration: request.maxDuration } : request);

/** Parameters written to the spend log. Never the prompt. */
export function logParams(request) {
  if (request.kind === 'image') return { size: request.size, aspectRatio: request.aspectRatio, count: request.count };
  return {
    resolution: request.resolution,
    duration: request.autoDuration ? 'auto' : request.duration,
    aspectRatio: request.aspectRatio,
    audio: request.audio,
    ...(request.image ? { image: true } : {}),
  };
}

/** A one-line description, e.g. "seedance-2.0-mini · text-to-video · 480p · 5s · 16:9 · audio on". */
export function describeRequest(r) {
  if (r.kind === 'image') return [r.model, r.mode, r.size, r.aspectRatio].join(' · ');
  return [r.model, r.mode, r.resolution, r.autoDuration ? `auto (up to ${r.maxDuration}s)` : `${r.duration}s`,
    r.aspectRatio, r.audio ? 'audio on' : 'audio off'].join(' · ');
}
