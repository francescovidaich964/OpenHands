import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { renderWithProviders } from "test-utils";
import { QuoteSelectionPopup } from "#/components/features/chat/quote-selection-popup";
import { QuotePassageCard } from "#/components/features/chat/quote-passage-card";
import { flashMessage, selectQuotedPassage } from "#/utils/quote-anchor";
import type { PassageQuote } from "#/utils/message-quote";

vi.mock("#/utils/quote-anchor", () => ({
  flashMessage: vi.fn(),
  selectQuotedPassage: vi.fn(() => null),
}));

const quote: PassageQuote = {
  eventId: "evt-1",
  author: "agent",
  caption: "why this part?",
  content: "the quoted passage",
  truncated: false,
};

const position = { x: 120, y: 240 };

beforeEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = "";
});

describe("QuoteSelectionPopup", () => {
  const setup = (
    overrides: Partial<Parameters<typeof QuoteSelectionPopup>[0]> = {},
  ) => {
    const handlers = {
      onSave: vi.fn(),
      onSend: vi.fn(),
      onStage: vi.fn(),
      ...overrides,
    };
    renderWithProviders(
      <QuoteSelectionPopup position={position} {...handlers} />,
    );
    return handlers;
  };

  it("sends the comment on Enter", () => {
    const { onSend, onStage } = setup();
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "look here" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSend).toHaveBeenCalledWith("look here");
    expect(onStage).not.toHaveBeenCalled();
  });

  it("stages the quote for the composer on Escape", () => {
    const { onSend, onStage } = setup();
    const field = screen.getByRole("textbox");
    fireEvent.change(field, { target: { value: "look here" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onStage).toHaveBeenCalledWith("look here");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends from the primary button", () => {
    const { onSend } = setup();
    fireEvent.click(screen.getByTestId("quote-primary-button"));
    expect(onSend).toHaveBeenCalledWith("");
  });

  it("stages from the secondary button", () => {
    const { onStage } = setup();
    fireEvent.click(screen.getByTestId("quote-stage-button"));
    expect(onStage).toHaveBeenCalledWith("");
  });

  it("saves instead of sending while editing a staged quote", () => {
    const { onSend, onSave } = setup();
    renderWithProviders(
      <QuoteSelectionPopup
        position={position}
        initialCaption="earlier note"
        isEditing
        onSave={onSave}
        onSend={onSend}
        onStage={vi.fn()}
      />,
    );
    const fields = screen.getAllByRole("textbox");
    const field = fields[fields.length - 1];
    expect(field).toHaveValue("earlier note");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(onSave).toHaveBeenCalledWith("earlier note");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("carries data-quote-ui so the feed ignores clicks in it", () => {
    const { container } = render(
      <QuoteSelectionPopup
        position={position}
        onSave={vi.fn()}
        onSend={vi.fn()}
        onStage={vi.fn()}
      />,
    );
    expect(container.querySelector("[data-quote-ui]")).toBeTruthy();
  });
});

describe("QuotePassageCard", () => {
  it("shows the passage and the caption", () => {
    renderWithProviders(<QuotePassageCard quote={quote} />);
    expect(screen.getByTestId("quote-card")).toBeInTheDocument();
    expect(screen.getByText("the quoted passage")).toBeInTheDocument();
    expect(screen.getByText("why this part?")).toBeInTheDocument();
  });

  it("jumps to the source message and highlights the passage", () => {
    const bubble = document.createElement("article");
    bubble.setAttribute("data-message-event-id", "evt-1");
    document.body.appendChild(bubble);

    renderWithProviders(
      <QuotePassageCard quote={{ ...quote, startLine: 5, endLine: 6 }} />,
    );
    fireEvent.click(screen.getByTestId("quote-card"));
    expect(selectQuotedPassage).toHaveBeenCalledWith(
      bubble,
      "the quoted passage",
      5,
      6,
    );
    expect(flashMessage).toHaveBeenCalledWith(bubble);
  });

  it("edits the staged quote in the composer pill instead of jumping", () => {
    const onEdit = vi.fn();
    renderWithProviders(<QuotePassageCard quote={quote} onEdit={onEdit} />);
    fireEvent.click(screen.getByTestId("quote-card"));
    expect(onEdit).toHaveBeenCalled();
    expect(flashMessage).not.toHaveBeenCalled();
  });
});
