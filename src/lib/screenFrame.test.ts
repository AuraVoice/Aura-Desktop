import { describe, expect, it } from "vitest";
import {
  GUIDE_FIXED_HEADER_LEN,
  GUIDE_MAGIC,
  GUIDE_PROTOCOL_VERSION,
  parseGuideEnvelope,
} from "./screenFrame";

function envelope(options: {
  magic?: number;
  version?: number;
  verdict?: number;
  payload?: Uint8Array;
  headerLen?: number;
  payloadLen?: number;
}) {
  const payload = options.payload ?? new Uint8Array();
  const buffer = new ArrayBuffer(GUIDE_FIXED_HEADER_LEN + payload.length);
  const view = new DataView(buffer);
  view.setUint32(0, options.magic ?? GUIDE_MAGIC, true);
  view.setUint16(4, options.version ?? GUIDE_PROTOCOL_VERSION, true);
  view.setUint8(6, options.verdict ?? 0);
  for (let index = 0; index < 16; index += 1) view.setUint8(7 + index, index + 1);
  view.setBigUint64(23, 7n, true);
  view.setUint32(31, 9, true);
  view.setUint32(35, options.headerLen ?? GUIDE_FIXED_HEADER_LEN, true);
  view.setUint32(39, options.payloadLen ?? payload.length, true);
  new Uint8Array(buffer, GUIDE_FIXED_HEADER_LEN).set(payload);
  return buffer;
}

function framePayload() {
  const payload = new Uint8Array(31);
  const view = new DataView(payload.buffer);
  view.setInt32(0, -1920, true);
  view.setInt32(4, 0, true);
  view.setUint32(8, 1920, true);
  view.setUint32(12, 1080, true);
  view.setFloat32(16, 1.25, true);
  view.setUint32(20, 1280, true);
  view.setUint32(24, 720, true);
  payload.set([0xff, 0xd8, 0xff], 28);
  return payload;
}

describe("parseGuideEnvelope", () => {
  it("parses a valid send envelope", () => {
    const parsed = parseGuideEnvelope(envelope({ verdict: 2, payload: framePayload() }));
    expect(parsed.verdict).toBe("send");
    expect(parsed.frameId).toBe("100f0e0d0c0b0a090807060504030201:9");
    expect(parsed.guideEpoch).toBe(7);
    if (parsed.verdict !== "send") throw new Error("expected send");
    expect(parsed.geometry.scaleFactor).toBe(1.25);
    expect(Array.from(parsed.bytes)).toEqual([0xff, 0xd8, 0xff]);
  });

  it("rejects unknown magic and version", () => {
    expect(() => parseGuideEnvelope(envelope({ magic: 1 }))).toThrow(/magic/);
    expect(() => parseGuideEnvelope(envelope({ version: 2 }))).toThrow(/version/);
  });

  it("rejects inconsistent header and payload lengths", () => {
    expect(() => parseGuideEnvelope(envelope({ headerLen: 42 }))).toThrow(/header length/);
    expect(() => parseGuideEnvelope(envelope({ payloadLen: 1 }))).toThrow(/payload length/);
  });

  it("rejects truncated fixed headers, geometry, and JPEG payloads", () => {
    expect(() => parseGuideEnvelope(new ArrayBuffer(GUIDE_FIXED_HEADER_LEN - 1))).toThrow(
      /fixed header/,
    );
    expect(() =>
      parseGuideEnvelope(envelope({ verdict: 2, payload: new Uint8Array(27) })),
    ).toThrow(/geometry or JPEG/);
    expect(() =>
      parseGuideEnvelope(envelope({ verdict: 3, payload: new Uint8Array(28) })),
    ).toThrow(/geometry or JPEG/);
  });

  it("rejects payloads on non-frame verdicts", () => {
    expect(() => parseGuideEnvelope(envelope({ verdict: 0, payload: new Uint8Array([1]) }))).toThrow(
      /must not contain/,
    );
  });
});
