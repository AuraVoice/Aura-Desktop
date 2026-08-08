import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { AgentDemoStep } from "./AgentDemoStep";
import { agentDemo as copy } from "../lib/copy";
import type { VoiceBarState } from "./useVoiceBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeVoice(overrides: Partial<VoiceBarState>): VoiceBarState {
  return {
    status: "disconnected",
    assistantCaption: "",
    errorMessage: null,
    showMicSettingsHint: false,
    isVoiceCapped: false,
    desiredActive: false,
    realtimeActivity: null,
    realtimeVisualizerTrack: null,
    startSession: vi.fn(() => Promise.resolve()),
    startBridgedSession: vi.fn(() => Promise.resolve()),
    endSession: vi.fn(() => Promise.resolve()),
    toggleSession: vi.fn(),
    room: null,
    ...overrides,
  } as VoiceBarState;
}

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
  vi.clearAllMocks();
});

function buttonByText(r: ReactTestRenderer, text: string) {
  return r.root
    .findAll((node) => node.type === "button")
    .find((node) => JSON.stringify(node.props.children).includes(text));
}

describe("AgentDemoStep", () => {
  it("starts a session from the idle state", () => {
    const voice = makeVoice({});
    const onFinish = vi.fn();
    act(() => {
      renderer = create(<AgentDemoStep voice={voice} onFinish={onFinish} />);
    });
    act(() => buttonByText(renderer!, copy.start)!.props.onClick());
    expect(voice.startBridgedSession).toHaveBeenCalledTimes(1);
  });

  it("ends the live session and hands off on finish", async () => {
    const voice = makeVoice({ status: "listening", desiredActive: true });
    const onFinish = vi.fn();
    act(() => {
      renderer = create(<AgentDemoStep voice={voice} onFinish={onFinish} />);
    });
    await act(async () => {
      buttonByText(renderer!, copy.finish)!.props.onClick();
    });
    expect(voice.endSession).toHaveBeenCalledTimes(1);
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("shows the error hint and still lets the user skip", async () => {
    const voice = makeVoice({ status: "error", desiredActive: false });
    const onFinish = vi.fn();
    act(() => {
      renderer = create(<AgentDemoStep voice={voice} onFinish={onFinish} />);
    });
    const status = renderer!.root.findByProps({ className: "agent-demo-status" });
    expect(JSON.stringify(status.props.children)).toContain(copy.errorHint);

    await act(async () => {
      buttonByText(renderer!, copy.skip)!.props.onClick();
    });
    expect(voice.endSession).not.toHaveBeenCalled();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
