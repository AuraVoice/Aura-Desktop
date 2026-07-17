import { afterEach, describe, expect, it, vi } from "vitest";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { ChoiceStep } from "./ChoiceStep";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { id: "search", label: "Google or search" },
  { id: "other", label: "Somewhere else" },
] as const;

let renderer: ReactTestRenderer | null = null;

afterEach(() => {
  if (renderer) {
    act(() => renderer?.unmount());
    renderer = null;
  }
});

function buttonByText(r: ReactTestRenderer, text: string) {
  return r.root
    .findAll((node) => node.type === "button")
    .find((node) => JSON.stringify(node.props.children).includes(text));
}

describe("ChoiceStep", () => {
  it("keeps continue disabled until an option is picked, then submits the id", () => {
    const onSubmit = vi.fn();
    act(() => {
      renderer = create(
        <ChoiceStep
          heading="How did you find Buddy?"
          body="Pick one"
          options={OPTIONS}
          otherPlaceholder="Where?"
          buttonLabel="Continue"
          onSubmit={onSubmit}
        />,
      );
    });
    const r = renderer!;

    expect(buttonByText(r, "Continue")!.props.disabled).toBe(true);

    act(() => buttonByText(r, "Google or search")!.props.onClick());
    expect(buttonByText(r, "Continue")!.props.disabled).toBe(false);

    act(() => buttonByText(r, "Continue")!.props.onClick());
    expect(onSubmit).toHaveBeenCalledWith({ id: "search", other: undefined });
  });

  it("captures freetext only for the other option", () => {
    const onSubmit = vi.fn();
    act(() => {
      renderer = create(
        <ChoiceStep
          heading="How did you find Buddy?"
          body="Pick one"
          options={OPTIONS}
          otherPlaceholder="Where?"
          buttonLabel="Continue"
          onSubmit={onSubmit}
        />,
      );
    });
    const r = renderer!;

    act(() => buttonByText(r, "Somewhere else")!.props.onClick());
    const input = r.root.findByType("input");
    act(() => input.props.onChange({ target: { value: "a podcast" } }));
    act(() => buttonByText(r, "Continue")!.props.onClick());

    expect(onSubmit).toHaveBeenCalledWith({ id: "other", other: "a podcast" });
  });
});
