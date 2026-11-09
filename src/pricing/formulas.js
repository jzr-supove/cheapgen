// Price formulas. Pure arithmetic: no I/O.

/**
 * Pixel size [width, height] for a request, from frame-sizes.json.
 * @returns {[number, number] | null}
 */
export function frameSize(request, frameSizes) {
  const series = request.frameSeries ?? request.model;
  const key = request.resolution ?? request.size;
  return frameSizes?.[series]?.[key]?.[request.aspectRatio] ?? null;
}

/**
 * Cost in USD of one request under one pricing entry.
 * @param {object} pricing     the `pricing` object of a prices.json entry
 * @param {object} request     canonical request ({ model, frameSeries, resolution|size, aspectRatio, duration, count })
 * @param {object} frameSizes  parsed frame-sizes.json
 * @returns {number}
 */
export function cost(pricing, request, frameSizes) {
  const count = request.count ?? 1;
  switch (pricing.type) {
    case 'perSecond':
      return pricing.usd * need(request.duration, 'duration') * count;
    case 'perImage':
      return pricing.usd * count;
    case 'perToken': {
      const [w, h] = needSize(request, frameSizes);
      const tokens = (w * h * need(request.duration, 'duration') * pricing.fps) / 1024;
      return (tokens / 1000) * pricing.usdPer1kTokens * count;
    }
    case 'perMegapixel': {
      const [w, h] = needSize(request, frameSizes);
      const mpUnit = pricing.mpDefinition ?? 1e6;
      const round = pricing.roundUp === false ? (x) => x : (x) => Math.ceil(x - 1e-12);
      const outputMp = round((w * h) / mpUnit);
      const inputMp = request.inputPixels ? round(request.inputPixels / mpUnit) : 0;
      const perImage = (pricing.usdPerRun ?? 0) + outputMp * (pricing.usdPerOutputMp ?? 0)
        + inputMp * (pricing.usdPerInputMp ?? 0);
      return perImage * count;
    }
    case 'tiered': {
      const [w, h] = needSize(request, frameSizes);
      const tier = pricing.tiers.find((t) => w * h <= t.maxPixels);
      if (!tier) throw new Error(`no price tier covers ${w}x${h}`);
      return tier.usd * count;
    }
    default:
      throw new Error(`unknown pricing type: ${pricing.type}`);
  }
}

function need(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`price needs a numeric ${name}`);
  return value;
}

function needSize(request, frameSizes) {
  const size = frameSize(request, frameSizes);
  if (!size) {
    throw new Error(`no frame size for ${request.frameSeries ?? request.model} `
      + `${request.resolution ?? request.size} ${request.aspectRatio}`);
  }
  return size;
}
