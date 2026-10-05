// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_DELAY_MS } from "../hooks/useDraftAutosave.ts";
import type { FormSchema } from "../types/form-builder.types.ts";
import {
  addField,
  createEmptyFormSchema,
  createFieldDefinition,
  findFieldById,
} from "../utils/form-schema.utils.ts";
import { FormBuilder } from "./FormBuilder.tsx";

const FORM_ID = "665f1c2e8f1b2c3d4e5f6a7b";

type SaveFn = (formId: string, schema: FormSchema) => Promise<void>;

interface Deferred {
  resolve: () => void;
  reject: (error: Error) => void;
}

/* A save function whose requests the test settles by hand. */
const controlledSave = () => {
  const pending: Deferred[] = [];
  const save = vi.fn<SaveFn>(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
  );
  return { save, pending };
};

const baseSchema = (): FormSchema => {
  const field = createFieldDefinition("TEXT", "name_field");
  field.label = "Name";
  return addField(createEmptyFormSchema(), field);
};

const setup = (
  save: SaveFn,
  initialSchema: FormSchema | undefined = baseSchema(),
) => {
  render(<FormBuilder formId={FORM_ID} initialSchema={initialSchema} saveDraft={save} />);
};

/*
 * Events are fired synchronously with fireEvent (not userEvent), which
 * keeps the fake-timer tests fully deterministic.
 */
const status = () => screen.getByRole("status");
const saveButton = () => screen.getByRole("button", { name: "Save Draft" });
const select = () => {
  fireEvent.click(screen.getByRole("button", { name: /^Select Name/ }));
};
const labelInput = () => screen.getByLabelText("Label") as HTMLInputElement;
/* Types one character at a time, like a user would. */
const append = (text: string) => {
  for (const char of text) {
    fireEvent.change(labelInput(), {
      target: { value: labelInput().value + char },
    });
  }
};
const backspace = () => {
  fireEvent.change(labelInput(), {
    target: { value: labelInput().value.slice(0, -1) },
  });
};
const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("loading the draft", () => {
  it("uses the persisted draft schema as the initial schema", () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(status().textContent).toBe("Saved");
  });

  it("uses an empty schema when there is no draft, without saving it", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    render(<FormBuilder formId={FORM_ID} saveDraft={save} />);

    expect(screen.getByRole("heading", { name: "Build your form" })).toBeTruthy();
    expect(status().textContent).toBe("Saved");

    await advance(AUTOSAVE_DELAY_MS * 4);

    expect(save).not.toHaveBeenCalled();
  });

  it("does not save on load or on selection changes", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    await advance(AUTOSAVE_DELAY_MS * 2);
    select();
    await advance(AUTOSAVE_DELAY_MS * 2);

    expect(save).not.toHaveBeenCalled();
    expect(status().textContent).toBe("Saved");
  });
});

describe("autosave debounce", () => {
  it("marks the form dirty on an edit and saves once after the delay", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("!");

    expect(status().textContent).toBe("Unsaved changes");
    expect(save).not.toHaveBeenCalled();

    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();

    await advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe("Saving…");

    pending[0].resolve();
    await flush();
    expect(status().textContent).toBe("Saved");
  });

  it("sends the saved schema to the right form", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("X");
    await advance(AUTOSAVE_DELAY_MS);

    const [formId, schema] = save.mock.calls[0];
    expect(formId).toBe(FORM_ID);
    expect(findFieldById(schema, "name_field")?.label).toBe("NameX");
    pending[0].resolve();
    await flush();
  });

  it("turns many rapid changes into a single request", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("abcd");
    await advance(AUTOSAVE_DELAY_MS - 1);
    expect(save).not.toHaveBeenCalled();
    await advance(1);

    expect(save).toHaveBeenCalledTimes(1);
    expect(findFieldById(save.mock.calls[0][1], "name_field")?.label).toBe(
      "Nameabcd",
    );
    pending[0].resolve();
    await flush();
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("restarts the delay on every change", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("a");
    await advance(AUTOSAVE_DELAY_MS - 100);
    append("b");
    await advance(AUTOSAVE_DELAY_MS - 100);
    expect(save).not.toHaveBeenCalled();
    await advance(100);

    expect(save).toHaveBeenCalledTimes(1);
    pending[0].resolve();
    await flush();
  });

  it("does not save when an edit is undone back to the saved schema", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);
    select();

    append("x");
    backspace();
    await advance(AUTOSAVE_DELAY_MS * 2);

    expect(save).not.toHaveBeenCalled();
    expect(status().textContent).toBe("Saved");
  });

  it("makes exactly one request per change", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);
    select();
    append("z");

    await advance(AUTOSAVE_DELAY_MS);
    await flush();
    await advance(AUTOSAVE_DELAY_MS * 5);

    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe("triggers", () => {
  it("autosaves after adding a field", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    fireEvent.click(screen.getByRole("button", { name: "Add Email field" }));
    await advance(AUTOSAVE_DELAY_MS);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].fields).toHaveLength(2);
  });

  it("autosaves after removing a field", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    fireEvent.click(screen.getByRole("button", { name: "Remove Name field" }));
    await advance(AUTOSAVE_DELAY_MS);

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0][1].fields).toHaveLength(0);
  });

  it("autosaves after a properties panel change", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);
    select();

    fireEvent.click(screen.getByLabelText("Required"));
    await advance(AUTOSAVE_DELAY_MS);

    expect(save).toHaveBeenCalledTimes(1);
    expect(findFieldById(save.mock.calls[0][1], "name_field")?.required).toBe(
      true,
    );
  });
});

describe("manual save", () => {
  it("saves immediately, bypassing the debounce", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("!");

    fireEvent.click(saveButton());

    expect(save).toHaveBeenCalledTimes(1);
    expect(status().textContent).toBe("Saving…");
    pending[0].resolve();
    await flush();
    expect(status().textContent).toBe("Saved");

    // The pending debounce did not produce a second request.
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("is disabled and busy while saving, preventing duplicate saves", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("!");

    fireEvent.click(saveButton());

    const busy = screen.getByRole("button", { name: "Saving..." });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(busy);
    expect(save).toHaveBeenCalledTimes(1);

    pending[0].resolve();
    await flush();
    // Saved: nothing left to save, so the button is disabled again.
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton().getAttribute("aria-busy")).toBe("false");
  });

  it("does nothing when there are no unsaved changes", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    fireEvent.click(saveButton());
    await advance(AUTOSAVE_DELAY_MS);

    expect(save).not.toHaveBeenCalled();
  });

  it("is a real button with an accessible name", () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    expect(saveButton().tagName).toBe("BUTTON");
  });
});

describe("failures", () => {
  it("shows the failure state and keeps the local changes", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("!");

    await advance(AUTOSAVE_DELAY_MS);
    pending[0].reject(new Error("Unable to reach the server"));
    await flush();

    expect(status().textContent).toBe("Unable to save");
    expect(status().getAttribute("data-state")).toBe("error");
    expect(labelInput().value).toBe("Name!");
    expect(screen.getByLabelText("Name!")).toBeTruthy();
  });

  it("does not retry automatically but retries on the next edit", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("!");
    await advance(AUTOSAVE_DELAY_MS);
    pending[0].reject(new Error("fail"));
    await flush();

    await advance(AUTOSAVE_DELAY_MS * 5);
    expect(save).toHaveBeenCalledTimes(1);

    append("?");
    expect(status().textContent).toBe("Unsaved changes");
    await advance(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(findFieldById(save.mock.calls[1][1], "name_field")?.label).toBe(
      "Name!?",
    );

    pending[1].resolve();
    await flush();
    expect(status().textContent).toBe("Saved");
  });

  it("can be retried with the manual Save Draft button", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("!");
    await advance(AUTOSAVE_DELAY_MS);
    pending[0].reject(new Error("fail"));
    await flush();
    expect(status().textContent).toBe("Unable to save");

    fireEvent.click(saveButton());
    expect(save).toHaveBeenCalledTimes(2);
    pending[1].resolve();
    await flush();

    expect(status().textContent).toBe("Saved");
  });

  it("does not crash for any kind of failure", async () => {
    for (const message of ["401", "403", "404", "413", "Validation failed"]) {
      const { save, pending } = controlledSave();
      setup(save);
      select();
      append("!");
      await advance(AUTOSAVE_DELAY_MS);
      pending[0].reject(new Error(message));
      await flush();

      expect(status().textContent).toBe("Unable to save");
      expect(screen.getByRole("main", { name: "Form canvas" })).toBeTruthy();
      expect(screen.queryByText(message)).toBeNull();
      cleanup();
    }
  });
});

describe("overlapping saves and stale responses", () => {
  it("an old response cannot mark newer edits as saved", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("A");
    await advance(AUTOSAVE_DELAY_MS); // request 1 (NameA) in flight
    expect(save).toHaveBeenCalledTimes(1);

    append("B"); // newer edit during the request
    expect(status().textContent).toBe("Saving…");

    pending[0].resolve(); // response for the OLDER snapshot
    await flush();

    expect(status().textContent).toBe("Unsaved changes");
    expect(labelInput().value).toBe("NameAB");
  });

  it("saves the newer edits after the older request finishes", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("A");
    await advance(AUTOSAVE_DELAY_MS);
    append("B");
    pending[0].resolve();
    await flush();

    await advance(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(findFieldById(save.mock.calls[1][1], "name_field")?.label).toBe(
      "NameAB",
    );

    pending[1].resolve();
    await flush();
    expect(status().textContent).toBe("Saved");
  });

  it("never runs two requests at once", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("A");
    await advance(AUTOSAVE_DELAY_MS);
    append("B");
    await advance(AUTOSAVE_DELAY_MS * 3); // timer fires while request 1 runs

    expect(save).toHaveBeenCalledTimes(1);
    pending[0].resolve();
    await flush();
  });

  it("a failure of an older request does not discard newer edits", async () => {
    const { save, pending } = controlledSave();
    setup(save);
    select();

    append("A");
    await advance(AUTOSAVE_DELAY_MS);
    append("B");
    pending[0].reject(new Error("fail"));
    await flush();

    expect(labelInput().value).toBe("NameAB");
    expect(status().textContent).toBe("Unsaved changes");

    await advance(AUTOSAVE_DELAY_MS);
    expect(save).toHaveBeenCalledTimes(2);
    pending[1].resolve();
    await flush();
    expect(status().textContent).toBe("Saved");
  });
});

describe("cleanup", () => {
  it("clears the debounce timer on unmount", async () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);
    select();
    append("!");
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    cleanup();

    expect(vi.getTimerCount()).toBe(0);
    await advance(AUTOSAVE_DELAY_MS * 3);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not update state after unmount when a request resolves late", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { save, pending } = controlledSave();
    setup(save);
    select();
    append("!");
    await advance(AUTOSAVE_DELAY_MS);

    cleanup();
    pending[0].resolve();
    await flush();

    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

describe("status indicator", () => {
  it("is a polite live region with text, not just color", () => {
    const save = vi.fn<SaveFn>(() => Promise.resolve());
    setup(save);

    expect(status().getAttribute("role")).toBe("status");
    expect(within(status()).getByText("Saved")).toBeTruthy();
  });

  it("is not shown without a formId (nothing persisted)", () => {
    render(<FormBuilder />);

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
  });
});
