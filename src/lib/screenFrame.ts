export interface ScreenFrameGeometry {
  monitorLeftPx: number;
  monitorTopPx: number;
  monitorWidthPx: number;
  monitorHeightPx: number;
  scaleFactor: number;
  jpegWidthPx: number;
  jpegHeightPx: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
  monitorX: number;
  monitorY: number;
  monitorWidth: number;
  monitorHeight: number;
}

export const SCREEN_GEOMETRY_HEADER_LEN = 4 * 7;
export const GUIDE_MAGIC = 0x44495547;
export const GUIDE_PROTOCOL_VERSION = 1;
export const GUIDE_FIXED_HEADER_LEN = 43;

export type GuideVerdict = "same" | "hold" | "send" | "pending" | "skip";

interface GuideEnvelopeBase {
  verdict: GuideVerdict;
  sessionId: string;
  guideEpoch: number;
  sequence: number;
  frameId: string;
}

export type GuideEnvelope =
  | (GuideEnvelopeBase & {
      verdict: "same" | "hold" | "skip";
      geometry?: never;
      bytes?: never;
    })
  | (GuideEnvelopeBase & {
      verdict: "send" | "pending";
      geometry: ScreenFrameGeometry;
      bytes: Uint8Array;
    });

export function asArrayBuffer(raw: unknown): ArrayBuffer {
  if (raw instanceof ArrayBuffer) return raw;
  if (ArrayBuffer.isView(raw)) {
    return raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer;
  }
  if (Array.isArray(raw)) return Uint8Array.from(raw as number[]).buffer;
  throw new Error(`capture returned ${Object.prototype.toString.call(raw)}, expected binary`);
}

export function parseCapturedFrame(buffer: ArrayBuffer): {
  geometry: ScreenFrameGeometry;
  bytes: Uint8Array;
} {
  if (buffer.byteLength < SCREEN_GEOMETRY_HEADER_LEN) {
    throw new Error("captured frame is shorter than its geometry header");
  }
  const view = new DataView(buffer);
  const geometry = readGeometry(view, 0);
  validateGeometry(geometry);
  return {
    geometry,
    bytes: new Uint8Array(buffer, SCREEN_GEOMETRY_HEADER_LEN),
  };
}

export function screenPointFor(
  geometry: ScreenFrameGeometry,
  jpegX: number,
  jpegY: number,
): ScreenPoint {
  const clampedX = Math.min(Math.max(jpegX, 0), geometry.jpegWidthPx);
  const clampedY = Math.min(Math.max(jpegY, 0), geometry.jpegHeightPx);
  const physicalX =
    geometry.monitorLeftPx + clampedX * (geometry.monitorWidthPx / geometry.jpegWidthPx);
  const physicalY =
    geometry.monitorTopPx + clampedY * (geometry.monitorHeightPx / geometry.jpegHeightPx);
  return {
    x: physicalX / geometry.scaleFactor,
    y: physicalY / geometry.scaleFactor,
    monitorX: geometry.monitorLeftPx / geometry.scaleFactor,
    monitorY: geometry.monitorTopPx / geometry.scaleFactor,
    monitorWidth: geometry.monitorWidthPx / geometry.scaleFactor,
    monitorHeight: geometry.monitorHeightPx / geometry.scaleFactor,
  };
}

export function parseGuideEnvelope(raw: unknown): GuideEnvelope {
  const buffer = asArrayBuffer(raw);
  if (buffer.byteLength < GUIDE_FIXED_HEADER_LEN) {
    throw new Error("Guide envelope is shorter than its fixed header");
  }

  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GUIDE_MAGIC) {
    throw new Error("Guide envelope has an unknown magic value");
  }
  if (view.getUint16(4, true) !== GUIDE_PROTOCOL_VERSION) {
    throw new Error("Guide envelope has an unsupported protocol version");
  }

  const verdict = verdictFor(view.getUint8(6));
  const headerLen = view.getUint32(35, true);
  const payloadLen = view.getUint32(39, true);
  if (headerLen !== GUIDE_FIXED_HEADER_LEN) {
    throw new Error("Guide envelope has an invalid header length");
  }
  if (payloadLen !== buffer.byteLength - headerLen) {
    throw new Error("Guide envelope payload length does not match its bytes");
  }

  const hasFrame = verdict === "send" || verdict === "pending";
  if (!hasFrame && payloadLen !== 0) {
    throw new Error(`Guide ${verdict} envelope must not contain a payload`);
  }
  if (hasFrame && payloadLen <= SCREEN_GEOMETRY_HEADER_LEN) {
    throw new Error(`Guide ${verdict} envelope is missing geometry or JPEG bytes`);
  }

  const sessionId = readSessionId(view);
  const epoch = view.getBigUint64(23, true);
  if (epoch > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Guide epoch exceeds JavaScript's safe integer range");
  }
  const guideEpoch = Number(epoch);
  const sequence = view.getUint32(31, true);
  const base: GuideEnvelopeBase = {
    verdict,
    sessionId,
    guideEpoch,
    sequence,
    frameId: `${sessionId}:${sequence}`,
  };

  if (!hasFrame) return base as GuideEnvelope;

  const geometry = readGeometry(view, headerLen);
  validateGeometry(geometry);
  return {
    ...base,
    verdict,
    geometry,
    bytes: new Uint8Array(
      buffer,
      headerLen + SCREEN_GEOMETRY_HEADER_LEN,
      payloadLen - SCREEN_GEOMETRY_HEADER_LEN,
    ),
  } as GuideEnvelope;
}

function verdictFor(value: number): GuideVerdict {
  const verdicts: GuideVerdict[] = ["same", "hold", "send", "pending", "skip"];
  const verdict = verdicts[value];
  if (!verdict) throw new Error("Guide envelope has an unknown verdict");
  return verdict;
}

function readSessionId(view: DataView): string {
  let value = "";
  for (let index = 22; index >= 7; index -= 1) {
    value += view.getUint8(index).toString(16).padStart(2, "0");
  }
  return value;
}

function readGeometry(view: DataView, offset: number): ScreenFrameGeometry {
  return {
    monitorLeftPx: view.getInt32(offset, true),
    monitorTopPx: view.getInt32(offset + 4, true),
    monitorWidthPx: view.getUint32(offset + 8, true),
    monitorHeightPx: view.getUint32(offset + 12, true),
    scaleFactor: view.getFloat32(offset + 16, true),
    jpegWidthPx: view.getUint32(offset + 20, true),
    jpegHeightPx: view.getUint32(offset + 24, true),
  };
}

function validateGeometry(geometry: ScreenFrameGeometry) {
  if (
    geometry.monitorWidthPx === 0 ||
    geometry.monitorHeightPx === 0 ||
    geometry.jpegWidthPx === 0 ||
    geometry.jpegHeightPx === 0 ||
    !Number.isFinite(geometry.scaleFactor) ||
    geometry.scaleFactor <= 0
  ) {
    throw new Error("screen frame has invalid geometry");
  }
}
